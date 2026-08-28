"""Person analytics worker — one process, up to seven features.

  frame -> [RF-DETR person detect] -> [ByteTrack] -> [enabled rules] -> events

Detection and tracking run ONCE per frame and every enabled rule reads the same
tracks. That is the whole reason these seven analytics share a worker: running
them separately would recompute identical boxes N times per frame.

ENABLED_FEATURES comes from the platform supervisor and contains only what the
organisation is licensed for, so an unlicensed rule is never constructed.

Run:  . .venv/bin/activate && python worker.py
"""
import os
import time

import cv2

import config
from events import emit
from stream import RtspFrameSource
from pipeline.detect import PersonDetector
from pipeline.rules import build_rules


def save_snapshot(frame, detail) -> str | None:
    """Write an annotated snapshot for ALERT events only.

    Images of identifiable people are personal data under the DPDP Act, so
    routine counting/queue summaries deliberately never produce one.
    """
    if not config.SAVE_SNAPSHOTS:
        return None
    if detail.get("type") not in config.SNAPSHOT_EVENTS:
        return None
    os.makedirs(config.SNAPSHOT_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    name = (f"{config.SNAPSHOT_DIR}/person_{config.CAMERA_ID[:8]}"
            f"_{detail['type']}_{ts}.jpg")
    ann = frame.copy()
    bbox = detail.get("bbox")
    if bbox:
        x1, y1, x2, y2 = (int(v) for v in bbox)
        cv2.rectangle(ann, (x1, y1), (x2, y2), (0, 0, 255), 2)
        cv2.putText(ann, detail["type"], (x1, max(12, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
    cv2.imwrite(name, ann)
    return name


def main() -> None:
    if not config.SOURCE_RTSP:
        raise SystemExit("SOURCE_RTSP not set (copy .env.example to .env)")
    if not config.ENABLED_FEATURES:
        raise SystemExit(
            "ENABLED_FEATURES is empty — nothing to run.\n"
            "The platform supervisor sets this from the organisation's licensed "
            "features. Running with no features would burn CPU producing nothing."
        )
    if not os.path.exists(config.MODEL_PATH):
        raise SystemExit(
            f"missing model: {config.MODEL_PATH}\n"
            "Export the COCO-pretrained RF-DETR once:\n"
            "  python -c \"import rfdetr; rfdetr.RFDETRSmall().export(output_dir='weights')\"\n"
            "then rename the result to person_rfdetr.onnx"
        )

    detector = PersonDetector(
        config.MODEL_PATH, conf=config.CONF, iou=config.IOU_NMS,
        min_height_px=config.MIN_HEIGHT_PX, max_aspect=config.MAX_ASPECT,
        lost_track_buffer=config.LOST_TRACK_BUFFER,
        frame_rate=int(config.SAMPLE_FPS) or 6,
    )
    rules = build_rules(config.ENABLED_FEATURES, config)
    if not rules:
        raise SystemExit(f"no known features in {config.ENABLED_FEATURES}")

    source = RtspFrameSource(config.SOURCE_RTSP, config.SAMPLE_FPS)

    print(f"[person] camera={config.CAMERA_ID} source={config.SOURCE_RTSP}")
    print(f"[person] features={[r.feature for r in rules]}")
    print(f"[person] sample_fps={config.SAMPLE_FPS} conf={config.CONF} "
          f"post_events={config.POST_EVENTS}")

    frame_no = 0
    emitted = 0
    t0 = time.time()

    for frame in source.frames():
        frame_no += 1
        now = time.time()

        tracks = detector.infer(frame)
        active = {t.track_id for t in tracks if t.track_id >= 0}

        for rule in rules:
            try:
                for detail in rule.update(tracks, frame_no, now):
                    snap = save_snapshot(frame, detail)
                    if snap:
                        detail["snapshot"] = snap
                    emit(detail)
                    emitted += 1
            except Exception as err:  # noqa: BLE001
                # One misbehaving rule must not take down the other six, nor the
                # worker the supervisor would then restart in a loop.
                print(f"[person] rule {rule.feature} failed: {type(err).__name__}: {err}")

        for rule in rules:
            rule.forget(active, frame_no)

        if frame_no % 50 == 0:
            fps = frame_no / (time.time() - t0)
            print(f"[person] frames={frame_no} ~{fps:.1f}/s people={len(tracks)} "
                  f"events={emitted} rejected={detector.rejected}")


if __name__ == "__main__":
    main()
