#!/usr/bin/env python3
"""Offline runner — same pipeline as worker.py, but over a video file, writing an
annotated MP4 so you can verify behaviour by eye.

    python run_video.py --video ../../data/vechiledetection/VID.mp4 \
                        --fps 10 --line 0,500,478,500

Boxes are labelled with the VOTED per-track class (not the per-frame guess), the
track id, and a lock marker once the class is frozen. That is the difference you
should see versus the raw output: labels stop flickering.
"""
import argparse
import os
import sys
import time
from collections import Counter

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
from pipeline.detect import VehicleDetector  # noqa: E402
from pipeline.temporal import TrackClassVoter  # noqa: E402
from pipeline.zone import CountingLine  # noqa: E402

COLOR = {
    "two_wheeler": (0, 255, 255), "three_wheeler": (255, 0, 255),
    "car": (0, 255, 0), "van": (255, 255, 0), "lcv": (0, 165, 255),
    "truck": (0, 0, 255), "bus": (255, 0, 0), "bicycle": (200, 200, 200),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--seconds", type=float, default=0, help="0 = whole video")
    ap.add_argument("--line", default="", help="x1,y1,x2,y2 counting line")
    ap.add_argument("--imgsz", type=int, default=config.IMG_SIZE)
    a = ap.parse_args()

    if not os.path.exists(a.video):
        sys.exit(f"missing video: {a.video}")
    out_path = a.out or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "outputs",
        os.path.splitext(os.path.basename(a.video))[0] + "_vehicle.mp4")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    per_class_conf, ar_bounds, min_px = config.resolve_thresholds()

    cap = cv2.VideoCapture(a.video)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    stride = max(1, round(src_fps / a.fps))
    out_fps = src_fps / stride
    end_f = total if a.seconds <= 0 else min(total, int(a.seconds * src_fps))
    n_proc = (end_f + stride - 1) // stride

    print(f"[video] {W}x{H} src_fps={src_fps:.1f} frames={total}")
    print(f"[proc ] stride={stride} out_fps={out_fps:.1f} to_process={n_proc}")
    print(f"[model] {config.MODEL_PATH} imgsz={a.imgsz} agnostic_nms={config.AGNOSTIC_NMS}")
    print(f"[conf ] {per_class_conf}")

    detector = VehicleDetector(
        config.MODEL_PATH, config.CLASSES, config.CONF, config.IOU_NMS,
        a.imgsz, config.AGNOSTIC_NMS, config.TRACKER,
        per_class_conf, ar_bounds, min_px,
    )
    voter = TrackClassVoter(config.VOTE_WINDOW, config.VOTE_MIN_FRAMES,
                            config.VOTE_LOCK_FRAMES)
    line = CountingLine(a.line)

    vw = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), out_fps, (W, H))
    totals, seen_tracks = Counter(), set()
    idx = done = 0
    t0 = time.time()

    while idx < end_f:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % stride:
            idx += 1
            continue

        dets = detector.infer(frame)
        active = {d.track_id for d in dets if d.track_id >= 0}
        done += 1

        for d in dets:
            cls_name, locked = d.cls_name, False
            if d.track_id >= 0:
                voter.update(d.track_id, d.cls_name, d.conf, done)
                seen_tracks.add(d.track_id)
                voted, locked = voter.klass(d.track_id)
                if voted:
                    cls_name = voted
                direction = line.check(d.track_id, d.centroid, done)
                if direction:
                    totals[cls_name] += 1

            x1, y1, x2, y2 = d.bbox
            col = COLOR.get(cls_name, (255, 255, 255))
            cv2.rectangle(frame, (x1, y1), (x2, y2), col, 2)
            tag = f"#{d.track_id} {cls_name}{'*' if locked else ''} {d.conf:.2f}"
            (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
            ly = max(th + 2, y1)
            cv2.rectangle(frame, (x1, ly - th - 3), (x1 + tw + 2, ly), col, -1)
            cv2.putText(frame, tag, (x1 + 1, ly - 2), cv2.FONT_HERSHEY_SIMPLEX,
                        0.4, (0, 0, 0), 1, cv2.LINE_AA)

        voter.forget_absent(active, done, config.TRACK_GRACE_FRAMES)
        line.forget_absent(active, set(voter.history.keys()), done)

        if line.enabled:
            cv2.line(frame, (int(line.p1[0]), int(line.p1[1])),
                     (int(line.p2[0]), int(line.p2[1])), (0, 0, 255), 2)

        hud = [f"t={idx/src_fps:6.1f}s  tracks={len(active)}  uniq={len(seen_tracks)}"]
        if line.enabled:
            hud.append(f"COUNTED={sum(totals.values())}  " +
                       " ".join(f"{k}:{v}" for k, v in totals.most_common()))
        cv2.rectangle(frame, (0, 0), (W, 8 + 15 * len(hud)), (0, 0, 0), -1)
        for i, t in enumerate(hud):
            cv2.putText(frame, t, (6, 16 + 15 * i), cv2.FONT_HERSHEY_SIMPLEX,
                        0.42, (255, 255, 255), 1, cv2.LINE_AA)

        vw.write(frame)
        if done % 50 == 0:
            el = time.time() - t0
            print(f"   {done}/{n_proc} {el/done:.2f}s/f eta {(n_proc-done)*el/done/60:.1f}min",
                  flush=True)
        idx += 1

    cap.release()
    vw.release()
    el = time.time() - t0
    print(f"\n[done] {out_path}")
    print(f"[done] {done} frames in {el/60:.1f} min ({el/max(done,1):.2f}s/frame)")
    print(f"[done] unique tracks seen: {len(seen_tracks)}")
    print(f"[done] rejected: {detector.rejected}")
    if line.enabled:
        print(f"[done] counted crossings: {sum(totals.values())} {dict(totals)}")
    else:
        print("[done] no --line given: detection/voting only, nothing counted")

    # Cumulative over the run — voter.locked only holds tracks still on screen.
    pct = 100 * voter.total_locked / max(voter.total_tracks, 1)
    print(f"[done] class locked on {voter.total_locked}/{voter.total_tracks} "
          f"tracks ({pct:.0f}%)")
    if pct < 50:
        print("[done] NOTE: low lock rate means most tracks lived fewer than "
              f"VOTE_LOCK_FRAMES={config.VOTE_LOCK_FRAMES} frames. Expected on a "
              "moving camera; on fixed CCTV it should be high. Lower the setting "
              "if vehicles genuinely transit the view that fast.")


if __name__ == "__main__":
    main()
