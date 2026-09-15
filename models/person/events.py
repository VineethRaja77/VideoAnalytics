"""Emit person-analytics events to the platform (or print in dev).

Mirrors the other modules. `module` is "person"; the `type` field carries the
FEATURE-level event name (intrusion, loitering, ...) so the platform can route
and licence-check per feature rather than per module.

Privacy: images of identifiable people are personal data under India's DPDP Act.
Only alert-type events carry a snapshot (see config.SNAPSHOT_EVENTS); routine
counting never writes one.
"""
import datetime
import uuid

import requests

import config


def emit(detail: dict) -> None:
    payload = {
        "module": "person",
        # The licensable feature. Sent explicitly so the platform never has to
        # infer it: `_cleared` suffixes are recovery events for the same feature.
        "feature": str(detail.get("type", "")).replace("_cleared", "") or None,
        "type": detail.get("type", "person_event"),
        "eventId": str(uuid.uuid4()),
        "cameraId": config.CAMERA_ID,
        "trackId": detail.get("trackId"),
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "details": detail,
        "snapshot": detail.get("snapshot"),
    }
    if not config.POST_EVENTS:
        print(f"[{payload['type'].upper()}] {payload['at']} "
              f"cam={config.CAMERA_ID[:8]} {detail}")
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
