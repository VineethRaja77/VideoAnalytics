"""Vehicle detection / classification / counting worker.

  frame ->
    [detect + ByteTrack] -> [agnostic NMS] -> [per-class conf] -> [geometry gate]
    -> [per-track class vote] -> [counting line] -> crossing event + snapshot

One process per camera. Run:  . .venv/bin/activate && python worker.py
"""
import os
import time
from collections import Counter

import cv2

import config
from stream import RtspFrameSource
from events import emit_crossing, emit_summary
from pipeline.detect import VehicleDetector
from pipeline.temporal import TrackClassVoter
from pipeline.zone import CountingLine
from pipeline.rules import build_vehicle_rules


def save_snapshot(frame, det, cls_name) -> str | None:
    if not config.SAVE_SNAPSHOTS:
        return None
    os.makedirs(config.SNAPSHOT_DIR, exist_ok=True)
    x1, y1, x2, y2 = det.bbox
    ts = time.strftime("%Y%m%d-%H%M%S")
    name = (f"{config.SNAPSHOT_DIR}/veh_{config.CAMERA_ID[:8]}"
            f"_t{det.track_id}_{cls_name}_{ts}.jpg")
    annotated = frame.copy()
    cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 2)
    cv2.putText(annotated, cls_name, (x1, max(12, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
    cv2.imwrite(name, annotated)
    return name


def main() -> None:
    if not config.SOURCE_RTSP:
        raise SystemExit("SOURCE_RTSP not set (copy .env.example to .env)")

    per_class_conf, ar_bounds, min_px = config.resolve_thresholds()

    print(f"[vehicle] camera={config.CAMERA_ID} source={config.SOURCE_RTSP}")
    print(f"[vehicle] sample_fps={config.SAMPLE_FPS} imgsz={config.IMG_SIZE} "
          f"agnostic_nms={config.AGNOSTIC_NMS} post_events={config.POST_EVENTS}")
    print(f"[vehicle] counting_line={'on' if config.COUNT_LINE else 'OFF (detect only)'}")
    print(f"[vehicle] conf={per_class_conf}")

    detector = VehicleDetector(
        config.MODEL_PATH, config.CLASSES, config.CONF, config.IOU_NMS,
        config.IMG_SIZE, config.AGNOSTIC_NMS, config.TRACKER,
        per_class_conf, ar_bounds, min_px,
    )
    voter = TrackClassVoter(config.VOTE_WINDOW, config.VOTE_MIN_FRAMES,
                            config.VOTE_LOCK_FRAMES)
    line = CountingLine(config.COUNT_LINE)
    # Rule features run on the detections/tracks already produced — no extra
    # model. Only the org's LICENSED features are constructed.
    rules = build_vehicle_rules(config.ENABLED_FEATURES, config)
    if rules:
        print(f"[vehicle] rule features={[r.feature for r in rules]}")
    source = RtspFrameSource(config.SOURCE_RTSP, config.SAMPLE_FPS)

    totals = Counter()        # lifetime, for the console line
    window = Counter()        # since the last summary — this is what gets emitted
    frame_no = 0
    t0 = time.time()
    last_summary = t0

    for frame in source.frames():
        frame_no += 1
        dets = detector.infer(frame)
        active = {d.track_id for d in dets if d.track_id >= 0}

        crossings: dict[int, str] = {}
        for d in dets:
            if d.track_id < 0:
                continue
            voter.update(d.track_id, d.cls_name, d.conf, frame_no)

            direction = line.check(d.track_id, d.centroid, frame_no)
            if direction is None:
                continue
            crossings[d.track_id] = direction

            # Use the VOTED class, never the single-frame class — the whole point
            # of the vote is that one frame must not decide a vehicle's identity.
            cls_name, locked = voter.klass(d.track_id)
            if cls_name is None:
                cls_name = d.cls_name  # crossed before enough frames accumulated

            totals[cls_name] += 1
            window[cls_name] += 1
            detail = {
                "trackId": d.track_id,
                "vehicleType": cls_name,
                "direction": direction,
                "classLocked": locked,
                "classStability": round(voter.stability(d.track_id), 2),
                "detConf": round(d.conf, 3),
                "bbox": list(d.bbox),
            }
            snap = save_snapshot(frame, d, cls_name)
            if snap:
                detail["snapshot"] = snap
            emit_crossing(config.CAMERA_ID, detail)

        # Rule features. One failing rule must not take down counting or the
        # other rules, nor kill a worker the supervisor would then restart.
        now_ts = time.time()
        for rule in rules:
            try:
                for detail in rule.update(dets, crossings, frame_no, now_ts):
                    detail["cameraId"] = config.CAMERA_ID
                    snap = save_snapshot(frame, dets[0], detail["type"]) if dets else None
                    if snap:
                        detail["snapshot"] = snap
                    emit_crossing(config.CAMERA_ID, detail)
            except Exception as err:  # noqa: BLE001
                print(f"[vehicle] rule {rule.feature} failed: {type(err).__name__}: {err}")
        for rule in rules:
            rule.forget(active, frame_no)

        voter.forget_absent(active, frame_no, config.TRACK_GRACE_FRAMES)
        line.forget_absent(active, set(voter.history.keys()), frame_no)

        now = time.time()
        if config.SUMMARY_INTERVAL_S and now - last_summary >= config.SUMMARY_INTERVAL_S:
            # Emit the DELTA for this window, not lifetime totals. Sending
            # cumulative counts alongside a windowSeconds field would make every
            # summary look like ever-growing traffic to the platform.
            if window:
                emit_summary(config.CAMERA_ID, dict(window), now - last_summary)
            window.clear()
            last_summary = now

        if frame_no % 50 == 0:
            fps = frame_no / (now - t0)
            print(f"[vehicle] frames={frame_no} ~{fps:.1f}/s tracks={len(active)} "
                  f"counted={sum(totals.values())} "
                  f"rejected={detector.rejected}")


if __name__ == "__main__":
    main()
