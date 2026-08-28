"""Abandoned / removed object worker.

  frame -> [dual background subtraction] -> [persistence] -> [edge test] -> events

No model, no weights, no training.

Run:  . .venv/bin/activate && python worker.py
"""
import os
import time

import cv2

import config
from events import emit
from stream import RtspFrameSource
from pipeline.detect import ObjectDetector

# Which event types this worker is licensed to emit. The supervisor passes the
# org's licensed features; an event whose type is not licensed is dropped rather
# than sent, so buying object_left never silently delivers object_removed too.
def _allowed(evt_type: str) -> bool:
    base = evt_type.replace("_cleared", "")
    return base in config.ENABLED_FEATURES


def save_snapshot(frame, detail) -> str | None:
    if not config.SAVE_SNAPSHOTS or detail["type"].endswith("_cleared"):
        return None
    os.makedirs(config.SNAPSHOT_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    name = f"{config.SNAPSHOT_DIR}/object_{config.CAMERA_ID[:8]}_{detail['type']}_{ts}.jpg"
    ann = frame.copy()
    if detail.get("bbox"):
        x1, y1, x2, y2 = (int(v) for v in detail["bbox"])
        cv2.rectangle(ann, (x1, y1), (x2, y2), (0, 165, 255), 3)
        cv2.putText(ann, detail["type"], (x1, max(14, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)
    cv2.imwrite(name, ann)
    return name


def main() -> None:
    if not config.SOURCE_RTSP:
        raise SystemExit("SOURCE_RTSP not set (copy .env.example to .env)")
    if not config.ENABLED_FEATURES:
        raise SystemExit("ENABLED_FEATURES is empty — nothing to run.")

    det = ObjectDetector(
        warmup_frames=config.WARMUP_FRAMES,
        slow_lr=config.SLOW_LR,
        fast_lr=config.FAST_LR,
        min_area_frac=config.MIN_AREA_FRAC,
        max_area_frac=config.MAX_AREA_FRAC,
        persist_seconds=config.PERSIST_SECONDS,
        match_iou=config.MATCH_IOU,
        gone_seconds=config.GONE_SECONDS,
        edge_delta=config.EDGE_DELTA,
        cooldown_seconds=config.COOLDOWN_SECONDS,
        proc_width=config.PROC_WIDTH,
        zone_mask_spec=config.OBJECT_ZONE,
    )
    source = RtspFrameSource(config.SOURCE_RTSP, config.SAMPLE_FPS)

    print(f"[object] camera={config.CAMERA_ID} source={config.SOURCE_RTSP}")
    print(f"[object] features={config.ENABLED_FEATURES} "
          f"persist={config.PERSIST_SECONDS}s zone={'set' if config.OBJECT_ZONE else 'whole frame'}")
    print("[object] learning the empty scene before judging anything ...")

    n = 0
    for frame in source.frames():
        n += 1
        now = time.time()
        try:
            for detail in det.update(frame, now):
                if not _allowed(detail["type"]):
                    continue
                snap = save_snapshot(frame, detail)
                if snap:
                    detail["snapshot"] = snap
                emit(detail)
        except Exception as err:  # noqa: BLE001
            print(f"[object] detector error: {type(err).__name__}: {err}")

        if n % 60 == 0:
            print(f"[object] frames={n} {det.status()}")


if __name__ == "__main__":
    main()
