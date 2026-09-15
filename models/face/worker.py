"""Face recognition worker.

  frame ->
    [YuNet detect + align] -> [quality gate: eye distance] -> [AuraFace embed]
    -> [gallery match + threshold] -> [IoU track] -> [identity vote]
    -> confirmed identity (or UNKNOWN) -> snapshot + event

One process per camera. Run:  . .venv/bin/activate && python worker.py

Nothing is trained. Enrol people with enroll.py; this only reads the gallery.
"""
import os
import time

import cv2

import config
from stream import RtspFrameSource
from events import emit_identity
from pipeline.detect import FaceDetector
from pipeline.embed import build_embedder
from pipeline.gallery import Gallery, UNKNOWN
from pipeline.alerting import AlertGate
from pipeline.schedule import load_schedules, active as schedule_active
from pipeline.track import IouTracker
from pipeline.temporal import IdentityVoter


def save_snapshot(frame, face, person, track_id) -> str | None:
    if not config.SAVE_SNAPSHOTS:
        return None
    if person == UNKNOWN and not config.SAVE_UNKNOWN_SNAPSHOTS:
        # Storing images of unidentified people is the highest-risk artefact in
        # this module under DPDP; off unless explicitly enabled.
        return None
    os.makedirs(config.SNAPSHOT_DIR, exist_ok=True)
    x1, y1, x2, y2 = face.bbox
    ts = time.strftime("%Y%m%d-%H%M%S")
    # The person's NAME is deliberately not in the filename.
    #
    # A directory listing would otherwise be a roster of who was seen and when,
    # readable by anyone with shell access and by every backup and log-shipping
    # tool that touches the path — personal data escaping the database that
    # holds it, with no purpose that the event row does not already serve. The
    # track id identifies the image just as well and means nothing on its own.
    name = f"{config.SNAPSHOT_DIR}/face_{config.CAMERA_ID[:8]}_t{track_id}_{ts}.jpg"
    ann = frame.copy()
    col = (0, 0, 255) if person == UNKNOWN else (0, 255, 0)
    cv2.rectangle(ann, (x1, y1), (x2, y2), col, 2)
    cv2.putText(ann, person, (x1, max(12, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
    cv2.imwrite(name, ann)
    return name


def main() -> None:
    if not config.SOURCE_RTSP:
        raise SystemExit("SOURCE_RTSP not set (copy .env.example to .env)")

    # Refuse the development default. A production worker MUST be given an
    # org-scoped gallery by the supervisor; falling back to a shared file would
    # pool every client's biometrics together and match one tenant's cameras
    # against another tenant's staff.
    if config.GALLERY_PATH == config.DEFAULT_DEV_GALLERY and config.POST_EVENTS:
        raise SystemExit(
            "GALLERY_PATH is the development default while POST_EVENTS=true.\n"
            "The platform supervisor must pass a per-organisation gallery:\n"
            "    models/face/gallery/<organizationId>.npz\n"
            "Refusing to start rather than share one gallery across tenants."
        )

    gallery = Gallery(config.GALLERY_PATH)
    if not len(gallery):
        # Deliberately NOT a fatal error any more.
        #
        # A client enables face recognition on a camera and then enrols staff —
        # in that order, because the camera list is where they start. Exiting
        # here put the supervisor into a restart loop for a configuration state
        # that is normal and temporary. The worker now waits instead, reloading
        # the gallery when the platform writes it (see the hot-reload below).
        #
        # While the gallery is empty every face necessarily matches nobody, so
        # unknown-person alerts are SUPPRESSED: firing "unknown person" at every
        # passer-by before anyone is enrolled is an alert storm, and it is the
        # same mistake as an intrusion rule with no zone.
        print(f"[face] gallery is empty ({config.GALLERY_PATH}) — nobody is "
              f"enrolled yet. Running, but reporting no identities and NO "
              f"unknown-person alerts until staff are enrolled. Enrol from "
              f"Faces > Enrolled People, or: python enroll.py --dir people/")

    detector = FaceDetector(config.DETECTOR_PATH, config.DETECT_CONF)
    embedder = build_embedder(config.FACE_BACKEND, config.EMBEDDER_PATH)
    tracker = IouTracker(config.IOU_MATCH, config.TRACK_GRACE_FRAMES)
    voter = IdentityVoter(config.VOTE_WINDOW, config.VOTE_MIN_FRAMES,
                          config.VOTE_LOCK_FRAMES)
    source = RtspFrameSource(config.SOURCE_RTSP, config.SAMPLE_FPS)

    print(f"[face] camera={config.CAMERA_ID} source={config.SOURCE_RTSP}")
    print(f"[face] backend={embedder.name} gallery={len(gallery.people)} people / "
          f"{len(gallery)} embeddings")
    print(f"[face] threshold={config.MATCH_THRESHOLD} margin={config.MATCH_MARGIN} "
          f"min_eye={config.MIN_EYE_DISTANCE_PX}px")

    # When a face is worth telling the operator about. See pipeline/alerting.py
    # — this is what stands between "useful alerts" and "alerts nobody reads".
    schedules = load_schedules(config.FEATURE_SCHEDULES)
    sch = schedules.get("face_recognition")
    print(f"[face] schedule: {sch.describe() if sch else 'always on'}")

    gate = AlertGate(config.ALERT_COOLDOWN_S,
                     config.UNKNOWN_SAME_PERSON_SIM,
                     config.TRACK_IDENTITY_SIM)
    # How often to re-stat the gallery, expressed in frames so it tracks the
    # configured sample rate rather than drifting with it.
    reload_every = max(1, int(config.SAMPLE_FPS * config.GALLERY_RELOAD_SECONDS))
    frame_no = 0
    too_small = 0
    t0 = time.time()

    for frame in source.frames():
        frame_no += 1

        # Outside the window, stop before the expensive part. Detection and
        # embedding are the whole cost of this worker, so a camera that only
        # matters at night costs almost nothing during the day — which is what
        # makes a schedule worth having on a box running several cameras.
        if not schedule_active(schedules, "face_recognition"):
            continue

        faces = detector.detect(frame)
        ids = tracker.update([f.bbox for f in faces], frame_no)

        for face, tid in zip(faces, ids):
            # Quality gate: below this the face carries too few pixels for ANY
            # model to identify it. Report presence, never guess a name.
            if face.eye_distance < config.MIN_EYE_DISTANCE_PX:
                too_small += 1
                continue

            emb = embedder.embed(face.aligned)

            # Has this track been HIJACKED by a different person?
            #
            # Faces are associated across frames by IoU alone, with no
            # appearance check. At a gate or turnstile people stand in the same
            # spot one after another, so when one leaves and the next arrives
            # the box overlaps and the tracker hands the newcomer the departing
            # person's track id. Two things then go wrong silently: the second
            # person's frames are voted into the first person's identity, and
            # the per-track cooldown swallows their alert entirely — a stranger
            # walks in and nobody is told.
            #
            # The embedding is already computed, so the check is free: if this
            # face does not resemble what this track looked like a moment ago,
            # the track is a different person and everything remembered about it
            # must be discarded.
            if gate.track_changed(tid, emb):
                voter.history.pop(tid, None)
                gate.reset_track(tid)

            name, sim, runner_up = gallery.match(
                emb, config.MATCH_THRESHOLD, config.MATCH_MARGIN)
            voter.update(tid, name, sim, frame_no)

            person, locked = voter.identity(tid)
            if person is None:
                continue          # not enough frames yet — say nothing
            if person == UNKNOWN and not config.ALERT_ON_UNKNOWN:
                continue
            # With nobody enrolled, "unknown" carries no information — it just
            # means the gallery is empty. Alerting on it would flood the client
            # with one alert per person per cooldown, forever.
            if person == UNKNOWN and not len(gallery):
                continue

            now = time.time()
            if not gate.should_announce(tid, person, emb, now):
                continue

            detail = {
                "trackId": tid,
                "person": person,
                "locked": locked,
                "voteConfidence": round(voter.confidence(tid), 2),
                "similarity": round(sim, 3),
                "runnerUp": round(runner_up, 3),
                "eyeDistancePx": round(face.eye_distance, 1),
                "bbox": list(face.bbox),
            }
            snap = save_snapshot(frame, face, person, tid)
            if snap:
                detail["snapshot"] = snap
            emit_identity(config.CAMERA_ID, detail)

        voter.forget_absent(tracker.active_ids, frame_no, config.TRACK_GRACE_FRAMES)

        # Adopt enrolments and removals made from the web console without a
        # restart. Checked on a frame interval rather than a timer so it costs
        # one stat() roughly every RELOAD_SECONDS and needs no extra thread.
        if frame_no % reload_every == 0 and gallery.reload_if_changed():
            print(f"[face] gallery reloaded: {len(gallery.people)} people / "
                  f"{len(gallery)} embeddings")
            # A removed person must stop being reported immediately. The voter
            # holds their name in per-track history, so a track already locked
            # onto them would keep announcing a person who was just revoked.
            voter.history.clear()

        # `announced` is keyed by track id, which a 24/7 worker issues without
        # bound — drop entries for retired tracks or it grows forever.
        if frame_no % 500 == 0:
            gate.forget_absent(tracker.active_ids | set(voter.history.keys()),
                               time.time())

        if frame_no % 50 == 0:
            fps = frame_no / (time.time() - t0)
            print(f"[face] frames={frame_no} ~{fps:.1f}/s faces={len(faces)} "
                  f"tracks={len(tracker.active_ids)} too_small={too_small}")


if __name__ == "__main__":
    main()
