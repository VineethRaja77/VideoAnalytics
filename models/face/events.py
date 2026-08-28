"""Emit face recognition events to the platform (or print in dev).

Mirrors models/ppe/events.py. Module is "face".

Privacy note (DPDP Act 2023): identities and face snapshots are biometric
personal data. Emitting them off-box is a processing activity that needs a
documented lawful basis, purpose limitation and a retention schedule.
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


def emit_identity(camera_id: str, detail: dict) -> None:
    is_unknown = detail.get("person") == "unknown"
    _post({
        "module": "face",
        "type": "face_unknown" if is_unknown else "face_recognized",
        "eventId": str(uuid.uuid4()),
        "cameraId": camera_id,
        "trackId": detail.get("trackId"),
        "at": datetime.datetime.utcnow().isoformat() + "Z",
        "details": detail,
        "snapshot": detail.get("snapshot"),
    }, "UNKNOWN" if is_unknown else "FACE")
