"""Emit a confirmed PPE violation to the platform (or print in dev).

The platform side exposes POST /api/analytics/events (shared-key auth, added on
the Node side). Until you set POST_EVENTS=true + PPE_INGEST_KEY, it just prints.
"""
import datetime
import requests

import config


def emit(camera_id: str, violation: dict) -> None:
    payload = {
        "module": "ppe",
        "feature": "ppe_compliance",
        "type": f"missing_{violation['item']}",
        "cameraId": camera_id,
        "trackId": violation.get("trackId"),
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "details": violation,
        "snapshot": violation.get("snapshot"),
    }

    if not config.POST_EVENTS:
        print(f"[VIOLATION] {payload['at']} cam={camera_id[:8]} track={violation.get('trackId')} "
              f"{payload['type']} visible={violation.get('visible')} compliance={violation.get('compliance')}")
        return

    try:
        headers = {"Content-Type": "application/json"}
        if config.INGEST_KEY:
            headers["X-Ingest-Key"] = config.INGEST_KEY
        r = requests.post(f"{config.PLATFORM_API}/api/analytics/events", json=payload, headers=headers, timeout=5)
        if r.status_code >= 300:
            print(f"[event] POST failed {r.status_code}: {r.text[:120]}")
    except Exception as e:  # noqa: BLE001
        print(f"[event] POST error: {e}")
