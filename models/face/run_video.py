#!/usr/bin/env python3
"""Offline runner — same pipeline as worker.py over a video file, writing an
annotated MP4.

    python run_video.py --video clip.mp4 --fps 6

Green box = recognised (name + similarity). Red = unknown. Grey = face too small
to attempt recognition, labelled with its interocular distance so you can see
immediately whether the camera is mounted close enough to work at all.
"""
import argparse
import os
import sys
import time
from collections import Counter

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
from pipeline.detect import FaceDetector  # noqa: E402
from pipeline.embed import build_embedder  # noqa: E402
from pipeline.gallery import Gallery, UNKNOWN  # noqa: E402
from pipeline.track import IouTracker  # noqa: E402
from pipeline.temporal import IdentityVoter  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--fps", type=float, default=config.SAMPLE_FPS)
    ap.add_argument("--seconds", type=float, default=0)
    ap.add_argument("--threshold", type=float, default=config.MATCH_THRESHOLD)
    ap.add_argument("--min-eye", type=float, default=config.MIN_EYE_DISTANCE_PX)
    a = ap.parse_args()

    if not os.path.exists(a.video):
        sys.exit(f"missing video: {a.video}")
    out_path = a.out or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "outputs",
        os.path.splitext(os.path.basename(a.video))[0] + "_face.mp4")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    gallery = Gallery(config.GALLERY_PATH)
    detector = FaceDetector(config.DETECTOR_PATH, config.DETECT_CONF)
    embedder = build_embedder(config.FACE_BACKEND, config.EMBEDDER_PATH)
    tracker = IouTracker(config.IOU_MATCH, config.TRACK_GRACE_FRAMES)
    voter = IdentityVoter(config.VOTE_WINDOW, config.VOTE_MIN_FRAMES,
                          config.VOTE_LOCK_FRAMES)

    cap = cv2.VideoCapture(a.video)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    stride = max(1, round(src_fps / a.fps))
    end_f = total if a.seconds <= 0 else min(total, int(a.seconds * src_fps))

    print(f"[video] {W}x{H} src_fps={src_fps:.1f} frames={total}")
    print(f"[face ] backend={embedder.name} gallery={len(gallery.people)} people")
    print(f"[face ] threshold={a.threshold} min_eye={a.min_eye}px")
    if not len(gallery):
        print("[face ] WARNING: empty gallery — every face will read 'unknown'. "
              "That is correct behaviour, but enrol people to see real matches.")

    vw = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"),
                         src_fps / stride, (W, H))
    seen = Counter()
    eye_dists = []
    idx = done = too_small = 0
    t0 = time.time()

    while idx < end_f:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % stride:
            idx += 1
            continue
        done += 1

        faces = detector.detect(frame)
        ids = tracker.update([f.bbox for f in faces], done)

        for face, tid in zip(faces, ids):
            x1, y1, x2, y2 = face.bbox
            eye_dists.append(face.eye_distance)

            if face.eye_distance < a.min_eye:
                too_small += 1
                col, label = (150, 150, 150), f"too small {face.eye_distance:.0f}px"
            else:
                emb = embedder.embed(face.aligned)
                name, sim, _ = gallery.match(emb, a.threshold, config.MATCH_MARGIN)
                voter.update(tid, name, sim, done)
                person, locked = voter.identity(tid)
                person = person or name
                seen[person] += 1
                if person == UNKNOWN:
                    col, label = (0, 0, 255), f"unknown {sim:.2f}"
                else:
                    col = (0, 255, 0)
                    label = f"{person}{'*' if locked else ''} {sim:.2f}"

            cv2.rectangle(frame, (x1, y1), (x2, y2), col, 2)
            for (lx, ly) in face.landmarks:
                cv2.circle(frame, (int(lx), int(ly)), 1, col, -1)
            tag = f"#{tid} {label}"
            (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
            ly2 = max(th + 2, y1)
            cv2.rectangle(frame, (x1, ly2 - th - 3), (x1 + tw + 2, ly2), col, -1)
            cv2.putText(frame, tag, (x1 + 1, ly2 - 2), cv2.FONT_HERSHEY_SIMPLEX,
                        0.4, (0, 0, 0), 1, cv2.LINE_AA)

        voter.forget_absent(tracker.active_ids, done, config.TRACK_GRACE_FRAMES)

        hud = f"t={idx/src_fps:6.1f}s faces={len(faces)} too_small={too_small}"
        cv2.rectangle(frame, (0, 0), (W, 22), (0, 0, 0), -1)
        cv2.putText(frame, hud, (6, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (255, 255, 255), 1, cv2.LINE_AA)
        vw.write(frame)
        idx += 1

    cap.release()
    vw.release()
    el = time.time() - t0
    print(f"\n[done] {out_path}")
    print(f"[done] {done} frames in {el/60:.1f} min ({el/max(done,1):.2f}s/frame)")
    print(f"[done] faces below min_eye: {too_small}")
    if eye_dists:
        import statistics as st
        eye_dists.sort()
        print(f"[done] interocular px: median={st.median(eye_dists):.0f} "
              f"p90={eye_dists[int(.9*len(eye_dists))-1]:.0f} "
              f"max={eye_dists[-1]:.0f}")
        print("[done] guide: <20 detection only | 40 usable | 80+ reliable")
    if seen:
        print(f"[done] identity votes: {dict(seen)}")


if __name__ == "__main__":
    main()
