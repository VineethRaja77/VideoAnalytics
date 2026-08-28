"""PPE compliance worker — orchestrates the full multi-stage pipeline.

  frame ->
    [person+pose+track] -> [zone gate] -> [visibility -> expected PPE]
    -> [PPE detect] -> [body-part association] -> [temporal verify]
    -> confirmed, visibility-aware violations -> snapshot + event

One process per camera. Run:  . .venv/bin/activate && python worker.py
"""
import os
import time
import cv2

import config
from stream import RtspFrameSource
from events import emit
from pipeline.zone import ZoneGate
from pipeline.ppe_detect import PPEDetector
from pipeline import visibility, association
from pipeline.temporal import ComplianceTracker


def save_snapshot(frame, person, violation) -> str | None:
    if not config.SAVE_SNAPSHOTS:
        return None
    os.makedirs(config.SNAPSHOT_DIR, exist_ok=True)
    x1, y1, x2, y2 = person.bbox
    ts = time.strftime("%Y%m%d-%H%M%S")
    name = f"{config.SNAPSHOT_DIR}/ppe_{config.CAMERA_ID[:8]}_t{violation['trackId']}_{violation['item']}_{ts}.jpg"
    annotated = frame.copy()
    cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 0, 255), 2)
    cv2.putText(annotated, f"NO {violation['item'].upper()}", (x1, max(0, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
    cv2.imwrite(name, annotated)
    return name


def main() -> None:
    if not config.SOURCE_RTSP:
        raise SystemExit("SOURCE_RTSP not set (copy .env.example to .env)")

    print(f"[ppe] camera={config.CAMERA_ID} source={config.SOURCE_RTSP}")
    print(f"[ppe] sample_fps={config.SAMPLE_FPS} zone={'on' if config.ZONE_LINE else 'off'} post_events={config.POST_EVENTS}")

    # ONE model now detects people AND PPE in a single pass; the separate
    # YOLO-pose stage is gone with its AGPL licence.
    ppe_detector = PPEDetector(
        config.MODEL_PATH, config.CLASSES, config.PPE_CONF, config.IOU_NMS,
        per_class_conf=config.PER_CLASS_CONF,
        frame_rate=int(config.SAMPLE_FPS) or 3,
    )
    gate = ZoneGate(config.ZONE_LINE)
    tracker = ComplianceTracker(
        config.TEMPORAL_WINDOW, config.TEMPORAL_MIN_FRAMES, config.VIOLATION_RATIO, config.ALERT_COOLDOWN_S
    )
    source = RtspFrameSource(config.SOURCE_RTSP, config.SAMPLE_FPS)

    processed = 0
    t0 = time.time()
    for frame in source.frames():
        processed += 1
        people, ppe_dets = ppe_detector.infer(frame)
        active_ids = {p.track_id for p in people if p.track_id >= 0}

        for person in people:
            if person.track_id < 0:
                continue
            if not gate.inside(person.bbox):
                continue  # not in the restricted area yet — skip

            # Visibility now comes from the person BOX plus the frame bounds:
            # a worker cut off at the bottom edge has no evaluable feet, so
            # boots are "not visible" rather than "missing".
            expected = visibility.expected_ppe(person.bbox, frame.shape)
            if not expected:
                continue  # nothing evaluable (e.g. only a partial/occluded detection)

            if not ppe_detector.available:
                # No PPE model yet: we can prove visibility reasoning works but
                # must not fabricate violations. Report expected set only.
                continue

            assessment = association.assess(person, expected, ppe_dets,
                                            config.REQUIRED_PPE, config.NEGATIVE_PPE,
                                            config.ABSENCE_MISSING)
            for v in tracker.update(person.track_id, assessment):
                v["cameraId"] = config.CAMERA_ID
                v["visible"] = sorted(visibility.visible_regions(person.bbox, frame.shape))
                v["compliance"] = tracker.snapshot_state(person.track_id)
                snap = save_snapshot(frame, person, v)
                if snap:
                    v["snapshot"] = snap
                emit(config.CAMERA_ID, v)

        tracker.forget_absent(active_ids)

        if processed % 20 == 0:
            fps = processed / (time.time() - t0)
            print(f"[ppe] frames={processed} ~{fps:.1f}/s people={len(people)} ppe_model={'on' if ppe_detector.available else 'off'}")


if __name__ == "__main__":
    main()
