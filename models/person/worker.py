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
import sys
import time

import cv2

import config
from events import emit
from stream import RtspFrameSource
from pipeline.detect import PersonDetector
from pipeline.rules import build_rules
from pipeline.schedule import load_schedules, active as schedule_active


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
    # sysexits.h EX_CONFIG. The supervisor treats this ONE code as "waiting for
    # an operator", not as a crash: no restart, no backoff, no "worker crashed"
    # alert to the client. Any other non-zero exit stays a real failure.
    EXIT_AWAITING_CONFIG = 78

    awaiting: list[tuple[str, str]] = []
    rules = build_rules(config.ENABLED_FEATURES, config, awaiting)
    if not rules:
        if awaiting:
            # Every licensed feature on this camera is a zone rule with no zone.
            # Exiting as a crash here put the supervisor into an endless restart
            # loop and sent the client admin a stream of "analytics crashed"
            # alerts for what is really an unfinished setup step.
            for feature, why in awaiting:
                print(f"AWAITING_CONFIGURATION: {feature} — {why}", file=sys.stderr)
            print("[person] nothing to run yet — every enabled feature on this "
                  "camera is still waiting to be configured. Exiting quietly; "
                  "the platform restarts this worker as soon as a zone is saved.")
            raise SystemExit(EXIT_AWAITING_CONFIG)
        raise SystemExit(f"no known features in {config.ENABLED_FEATURES}")

    source = RtspFrameSource(config.SOURCE_RTSP, config.SAMPLE_FPS)

    schedules = load_schedules(config.FEATURE_SCHEDULES)

    print(f"[person] camera={config.CAMERA_ID} source={config.SOURCE_RTSP}")
    print(f"[person] features={[r.feature for r in rules]}")
    for r in rules:
        sch = schedules.get(r.feature)
        print(f"[person]   {r.feature}: {sch.describe() if sch else 'always on'}")
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
            # Outside its window the rule is not merely silenced — it is not
            # updated at all, so dwell timers and "already alerted" state do not
            # accumulate against people who were legitimately there. A loitering
            # timer that ran all day would fire the instant the window opened.
            if not schedule_active(schedules, rule.feature, now):
                continue
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
