"""Emit vehicle events to the platform (or print in dev).

Mirrors models/ppe/events.py — same endpoint, same shared-key auth, module set
to "vehicle". Until POST_EVENTS=true + VEHICLE_INGEST_KEY are set it just prints.

Note on identity: trackId is a WITHIN-SESSION handle only. It is re-issued when a
track is lost and resets on restart, so it is never a durable key. The platform
should key on (cameraId, at, uuid). Global identity for a specific vehicle needs
the number plate, which is a separate model.
"""
import datetime
import uuid

import requests

import config


def _post(payload: dict, label: str) -> None:
    if not config.POST_EVENTS:
        print(f"[{label}] {payload['at']} cam={payload['cameraId'][:8]} "
              f"{payload.get('type')} {payload.get('details')}")
        return
    try:
        headers = {"Content-Type": "application/json"}
        if config.INGEST_KEY:
            headers["X-Ingest-Key"] = config.INGEST_KEY
        r = requests.post(f"{config.PLATFORM_API}/api/analytics/events",
                          json=payload, headers=headers, timeout=5)
        if r.status_code >= 300:
            print(f"[event] POST failed {r.status_code}: {r.text[:120]}")
    except Exception as e:  # noqa: BLE001
        print(f"[event] POST error: {e}")


# Event types that are their own licensable feature. A plain line crossing
# belongs to vehicle_count; the rule features name themselves.
_RULE_FEATURES = {"wrong_way", "illegal_parking", "congestion", "triple_riding"}


def emit_crossing(camera_id: str, detail: dict) -> None:
    kind = detail.get("type", "vehicle_crossed")
    base = str(kind).replace("_cleared", "")
    _post({
        "module": "vehicle",
        "feature": base if base in _RULE_FEATURES else "vehicle_count",
        "type": kind,
        "eventId": str(uuid.uuid4()),
        "cameraId": camera_id,
        "trackId": detail.get("trackId"),
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "details": detail,
        "snapshot": detail.get("snapshot"),
    }, "CROSS")


def emit_summary(camera_id: str, counts: dict, window_s: float) -> None:
    _post({
        "module": "vehicle",
        "feature": "vehicle_count",
        "type": "vehicle_count_summary",
        "eventId": str(uuid.uuid4()),
        "cameraId": camera_id,
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "details": {"counts": counts, "windowSeconds": round(window_s, 1)},
    }, "SUMMARY")
