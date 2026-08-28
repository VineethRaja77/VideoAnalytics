"""Camera tamper worker.

  frame -> [image statistics vs this camera's learned baseline] -> events

No model, no weights, no training. This is the cheapest analytic to run and
arguably the most valuable: a blinded camera silently stops producing PPE,
vehicle and person events, and without this nothing reports that.

Run:  . .venv/bin/activate && python worker.py
"""
import os
import time

import cv2

import config
from events import emit
from stream import RtspFrameSource
from pipeline.detect import TamperDetector


def save_snapshot(frame, detail) -> str | None:
    if not config.SAVE_SNAPSHOTS or detail.get("type") == "camera_tamper_cleared":
        return None
    os.makedirs(config.SNAPSHOT_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    name = (f"{config.SNAPSHOT_DIR}/tamper_{config.CAMERA_ID[:8]}"
            f"_{detail.get('condition', 'unknown')}_{ts}.jpg")
    ann = frame.copy()
    cv2.putText(ann, f"TAMPER: {detail.get('condition')}", (12, 32),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
    cv2.imwrite(name, ann)
    return name


def main() -> None:
    if not config.SOURCE_RTSP:
        raise SystemExit("SOURCE_RTSP not set (copy .env.example to .env)")

    det = TamperDetector(
        warmup_frames=config.WARMUP_FRAMES,
        baseline_frames=config.BASELINE_FRAMES,
        blur_drop=config.BLUR_DROP,
        edge_drop=config.EDGE_DROP,
        scene_change=config.SCENE_CHANGE,
        dark_level=config.DARK_LEVEL,
        frozen_delta=config.FROZEN_DELTA,
        hold_seconds=config.HOLD_SECONDS,
        cooldown_seconds=config.COOLDOWN_SECONDS,
        proc_width=config.PROC_WIDTH,
    )
    source = RtspFrameSource(config.SOURCE_RTSP, config.SAMPLE_FPS)

    print(f"[tamper] camera={config.CAMERA_ID} source={config.SOURCE_RTSP}")
    print(f"[tamper] sample_fps={config.SAMPLE_FPS} warmup={config.WARMUP_FRAMES} "
          f"hold={config.HOLD_SECONDS}s post_events={config.POST_EVENTS}")
    print("[tamper] learning this camera's baseline before judging anything ...")

    n = 0
    warned = False
    for frame in source.frames():
        n += 1
        now = time.time()
        try:
            for detail in det.update(frame, now):
                snap = save_snapshot(frame, detail)
                if snap:
                    detail["snapshot"] = snap
                emit(detail)
        except Exception as err:  # noqa: BLE001
            print(f"[tamper] detector error: {type(err).__name__}: {err}")

        if not warned and n > config.WARMUP_FRAMES:
            warned = True
            print(f"[tamper] baseline learned: {det.status()}")

        if n % 60 == 0:
            print(f"[tamper] frames={n} {det.status()}")


if __name__ == "__main__":
    main()
