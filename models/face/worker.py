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
from pipeline.track import IouTracker
from pipeline.temporal import IdentityVoter


def save_snapshot(frame, face, person) -> str | None:
    if not config.SAVE_SNAPSHOTS:
        return None
    if person == UNKNOWN and not config.SAVE_UNKNOWN_SNAPSHOTS:
        # Storing images of unidentified people is the highest-risk artefact in
        # this module under DPDP; off unless explicitly enabled.
        return None
    os.makedirs(config.SNAPSHOT_DIR, exist_ok=True)
    x1, y1, x2, y2 = face.bbox
    ts = time.strftime("%Y%m%d-%H%M%S")
    name = f"{config.SNAPSHOT_DIR}/face_{config.CAMERA_ID[:8]}_{person}_{ts}.jpg"
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

    gallery = Gallery(config.GALLERY_PATH)
    if not len(gallery):
        raise SystemExit(
            f"gallery is empty ({config.GALLERY_PATH}).\n"
            "Enrol people first:  python enroll.py --dir people/\n"
            "With no gallery every face is 'unknown', which is correct but useless."
        )

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

    announced = {}       # track_id -> last event time
    frame_no = 0
    too_small = 0
    t0 = time.time()

    for frame in source.frames():
        frame_no += 1
        faces = detector.detect(frame)
        ids = tracker.update([f.bbox for f in faces], frame_no)

        for face, tid in zip(faces, ids):
            # Quality gate: below this the face carries too few pixels for ANY
            # model to identify it. Report presence, never guess a name.
            if face.eye_distance < config.MIN_EYE_DISTANCE_PX:
                too_small += 1
                continue

            emb = embedder.embed(face.aligned)
            name, sim, runner_up = gallery.match(
                emb, config.MATCH_THRESHOLD, config.MATCH_MARGIN)
            voter.update(tid, name, sim, frame_no)

            person, locked = voter.identity(tid)
            if person is None:
                continue          # not enough frames yet — say nothing
            if person == UNKNOWN and not config.ALERT_ON_UNKNOWN:
                continue

            now = time.time()
            if now - announced.get(tid, 0) < config.ALERT_COOLDOWN_S:
                continue
            announced[tid] = now

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
            snap = save_snapshot(frame, face, person)
            if snap:
                detail["snapshot"] = snap
            emit_identity(config.CAMERA_ID, detail)

        voter.forget_absent(tracker.active_ids, frame_no, config.TRACK_GRACE_FRAMES)

        # `announced` is keyed by track id, which a 24/7 worker issues without
        # bound — drop entries for retired tracks or it grows forever.
        if frame_no % 500 == 0:
            live = tracker.active_ids | set(voter.history.keys())
            for tid in [t for t in announced if t not in live]:
                announced.pop(tid, None)

        if frame_no % 50 == 0:
            fps = frame_no / (time.time() - t0)
            print(f"[face] frames={frame_no} ~{fps:.1f}/s faces={len(faces)} "
                  f"tracks={len(tracker.active_ids)} too_small={too_small}")


if __name__ == "__main__":
    main()
