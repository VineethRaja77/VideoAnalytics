"""Offline PPE pipeline runner for VIDEO FILES (not live).

Runs the full pipeline on a recorded video, draws an annotated overlay
(person box + track id, keypoints, visible body regions, expected PPE, and —
if a PPE model is loaded — per-item compliance), and writes an output video
to the outputs/ folder. Also prints a per-run summary.

Usage:
  python run_video.py --input "data/PPE FILES/xxx.mp4" \
      --output outputs/xxx_annotated.mp4 \
      --stride 5 --max-frames 300 --out-width 1280
"""
import argparse
import os
import time
import cv2

import config
from pipeline.person_pose import PersonPose, KP
from pipeline.ppe_detect import PPEDetector
from pipeline import visibility, association
from pipeline.temporal import ComplianceTracker

GREEN = (0, 180, 0)
RED = (0, 0, 255)
GRAY = (150, 150, 150)
YELLOW = (0, 200, 220)

SKELETON = [
    ("l_shoulder", "r_shoulder"), ("l_shoulder", "l_elbow"), ("l_elbow", "l_wrist"),
    ("r_shoulder", "r_elbow"), ("r_elbow", "r_wrist"), ("l_shoulder", "l_hip"),
    ("r_shoulder", "r_hip"), ("l_hip", "r_hip"), ("l_hip", "l_knee"), ("l_knee", "l_ankle"),
    ("r_hip", "r_knee"), ("r_knee", "r_ankle"),
]


def draw_person(frame, person, compliance, expected, ppe_available):
    x1, y1, x2, y2 = person.bbox
    cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 180, 0), 2)
    cv2.putText(frame, f"ID {person.track_id}", (x1, max(0, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 180, 0), 2)

    # skeleton + keypoints
    for a, b in SKELETON:
        if a in person.keypoints and b in person.keypoints:
            pa, pb = person.keypoints[a], person.keypoints[b]
            cv2.line(frame, (int(pa[0]), int(pa[1])), (int(pb[0]), int(pb[1])), (0, 255, 255), 1)
    for name, (kx, ky, _) in person.keypoints.items():
        cv2.circle(frame, (int(kx), int(ky)), 3, (0, 255, 255), -1)

    # compliance / expected labels
    lines = []
    if not ppe_available:
        lines.append(("expected: " + ", ".join(sorted(expected)) if expected else "expected: none", YELLOW))
        lines.append(("PPE model: not loaded", GRAY))
    else:
        for item in sorted(expected):
            state = compliance.get(item, "unknown")
            color = RED if state == "missing" else GREEN if state == "present" else GRAY
            lines.append((f"{item}: {state}", color))
    y = y1 + 18
    for text, color in lines:
        cv2.putText(frame, text, (x1 + 3, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        y += 18


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--stride", type=int, default=5, help="process every Nth source frame")
    ap.add_argument("--max-frames", type=int, default=300, help="max frames to process (0 = all)")
    ap.add_argument("--out-width", type=int, default=1280)
    ap.add_argument("--start-sec", type=float, default=0.0)
    args = ap.parse_args()

    person_pose = PersonPose(config.POSE_MODEL, config.PERSON_CONF, config.IMG_SIZE, config.KP_CONF)
    ppe_detector = PPEDetector(config.PPE_MODELS, config.PPE_CONF, config.PPE_IMG_SIZE)
    tracker = ComplianceTracker(config.TEMPORAL_WINDOW, config.TEMPORAL_MIN_FRAMES,
                                config.VIOLATION_RATIO, config.ALERT_COOLDOWN_S)

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise SystemExit(f"cannot open {args.input}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if args.start_sec > 0:
        cap.set(cv2.CAP_PROP_POS_MSEC, args.start_sec * 1000)

    out_w = args.out_width
    out_h = int(src_h * out_w / src_w)
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    writer = cv2.VideoWriter(args.output, cv2.VideoWriter_fourcc(*"mp4v"),
                             max(1.0, src_fps / args.stride), (out_w, out_h))

    print(f"[run] {args.input}  {src_w}x{src_h}@{src_fps:.0f}  stride={args.stride} max={args.max_frames}")
    print(f"[run] PPE model: {'loaded' if ppe_detector.available else 'NOT loaded (person/pose/visibility only)'}")

    src_idx = 0
    processed = 0
    total_people = 0
    total_violations = 0
    t0 = time.time()
    while True:
        ok = cap.grab()
        if not ok:
            break
        if src_idx % args.stride != 0:
            src_idx += 1
            continue
        ok, frame = cap.retrieve()
        src_idx += 1
        if not ok:
            break

        people = person_pose.infer(frame)
        total_people += len(people)
        ppe_dets = ppe_detector.detect(frame) if ppe_detector.available else []
        active = {p.track_id for p in people if p.track_id >= 0}

        for person in people:
            expected = visibility.expected_ppe(person.keypoints)
            compliance = {}
            if ppe_detector.available and expected and person.track_id >= 0:
                assessment = association.assess(person, expected, ppe_dets,
                                                config.REQUIRED_PPE, config.NEGATIVE_PPE,
                                                config.ABSENCE_MISSING)
                for v in tracker.update(person.track_id, assessment):
                    total_violations += 1
                compliance = tracker.snapshot_state(person.track_id)
            draw_person(frame, person, compliance, expected, ppe_detector.available)

        tracker.forget_absent(active)

        # draw any PPE detections (debug) when a model is present
        for d in ppe_dets:
            bx = d["bbox"]
            cv2.rectangle(frame, (bx[0], bx[1]), (bx[2], bx[3]), (200, 0, 200), 1)
            cv2.putText(frame, d["class"], (bx[0], bx[1] - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 0, 200), 1)

        out = cv2.resize(frame, (out_w, out_h))
        cv2.putText(out, f"frame {processed}  people {len(people)}", (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        writer.write(out)

        processed += 1
        if processed % 20 == 0:
            print(f"[run] processed={processed} people_so_far={total_people} elapsed={time.time()-t0:.0f}s", flush=True)
        if args.max_frames and processed >= args.max_frames:
            break

    cap.release()
    writer.release()
    dt = time.time() - t0
    print(f"\n[done] processed {processed} frames in {dt:.0f}s ({processed/dt:.2f} fps)")
    print(f"[done] total person-detections={total_people}  confirmed violations={total_violations}")
    print(f"[done] output written -> {args.output}")


if __name__ == "__main__":
    main()
