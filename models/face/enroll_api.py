#!/usr/bin/env python3
"""JSON bridge so the platform can enrol faces without shelling out to a CLI.

enroll.py is the operator's tool: folders of images on the box running the
worker. That is useless to a client admin sitting in a browser, so this exposes
the same three operations over stdin/stdout for the Node server to call.

PROTOCOL
    stdin  : ONE JSON object
               {"action":"list"}
               {"action":"add","name":"ramesh","images":["<base64 jpeg>", ...]}
               {"action":"remove","name":"ramesh"}
    stdout : ONE JSON object, always. {"ok":true,...} or {"ok":false,"error":...}

WHY stdin AND NOT argv
    A base64 photograph on a command line would be visible in `ps` to every
    user on the host, and a face image is biometric personal data under India's
    DPDP Act 2023. Nothing identifiable is ever printed either — only counts,
    names and rejection reasons.

WHICH GALLERY
    config.GALLERY_PATH, which the caller sets per ORGANISATION. This process
    never chooses the file; a bug that let it default would pool every client's
    biometrics into one gallery. The guard below refuses the development
    default outright.

PER-IMAGE FEEDBACK IS THE POINT
    Enrolment fails quietly in the worst way: a photo where the face is too
    small still "succeeds" and the person is then never recognised. Every
    rejected image comes back with the actual reason so the admin can fix the
    photo instead of blaming the model months later.
"""
import base64
import binascii
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

import config  # noqa: E402
from pipeline.gallery import Gallery  # noqa: E402

# The gallery stores names in a fixed-width U128 numpy dtype: a longer name is
# TRUNCATED on save, so two people could silently collapse into one entry.
MAX_NAME = 128
MAX_IMAGES = 10
MAX_IMAGE_BYTES = 6 * 1024 * 1024


def _now_iso() -> str:
    """An absolute instant, stated as one.

    Stored rather than displayed — the console renders it in the site's
    timezone. Recording a bare local wall clock here would make a consent record
    ambiguous the first time anything moved zones, and a consent record that
    cannot say when consent was given is not a record.
    """
    return datetime.now(timezone.utc).isoformat()


def fail(msg: str, **extra):
    print(json.dumps({"ok": False, "error": msg, **extra}))
    sys.exit(0)          # a handled refusal is not a crash; exit 0, ok=false


def clean_name(raw) -> str:
    name = str(raw or "").strip()
    if not name:
        fail("A person needs a name.")
    if len(name) > MAX_NAME:
        fail(f"Name is longer than {MAX_NAME} characters. Longer names are "
             f"truncated in the gallery, which can merge two people into one.")
    return name


def do_list(gallery: Gallery) -> dict:
    people = []
    for p in gallery.people:
        meta = gallery.meta.get(p, {}) or {}
        people.append({
            "name": p,
            "images": gallery.names.count(p),
            "enrolledAt": meta.get("enrolledAt"),
            # Consent is the record a DPDP audit asks for. Reported even when
            # absent, so an older entry enrolled before this existed is visibly
            # missing it rather than silently indistinguishable from a
            # compliant one.
            "consent": meta.get("consent"),
        })
    return {"ok": True, "people": people, "embeddings": len(gallery)}


def do_add(gallery: Gallery, payload: dict) -> dict:
    name = clean_name(payload.get("name"))
    images = payload.get("images") or []
    if not isinstance(images, list) or not images:
        fail("No photographs were supplied.")
    if len(images) > MAX_IMAGES:
        fail(f"At most {MAX_IMAGES} photographs per request.")

    # Imported here, not at module scope: `list` and `remove` must keep working
    # on a box where the model weights are missing, so an admin can always see
    # and delete what is enrolled even when recognition itself cannot run.
    import cv2
    from pipeline.detect import FaceDetector
    from pipeline.embed import build_embedder

    if not os.path.exists(config.DETECTOR_PATH):
        fail(f"Face detector weights are missing at {config.DETECTOR_PATH}. "
             f"The face module is not fully installed on this server.")
    if not os.path.exists(config.EMBEDDER_PATH):
        fail(f"Face recognition weights are missing at {config.EMBEDDER_PATH}. "
             f"The face module is not fully installed on this server.")

    detector = FaceDetector(config.DETECTOR_PATH, config.DETECT_CONF)
    embedder = build_embedder(config.FACE_BACKEND, config.EMBEDDER_PATH)
    min_eye = config.MIN_EYE_DISTANCE_PX

    vecs, results = [], []
    for i, b64 in enumerate(images):
        label = f"photo {i + 1}"
        try:
            raw = base64.b64decode(str(b64), validate=True)
        except (binascii.Error, ValueError):
            results.append({"photo": label, "accepted": False,
                            "reason": "not a readable image"})
            continue
        if len(raw) > MAX_IMAGE_BYTES:
            results.append({"photo": label, "accepted": False,
                            "reason": f"larger than "
                                      f"{MAX_IMAGE_BYTES // (1024 * 1024)} MB"})
            continue

        frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            results.append({"photo": label, "accepted": False,
                            "reason": "not a JPEG or PNG image"})
            continue

        faces = detector.detect(frame)
        if not faces:
            results.append({"photo": label, "accepted": False,
                            "reason": "no face found in this photo"})
            continue

        faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
                   reverse=True)
        face = faces[0]
        extra = (f"; {len(faces)} faces present, used the largest"
                 if len(faces) > 1 else "")

        if face.eye_distance < min_eye:
            # The single most common cause of an enrolled person never being
            # recognised. Reject it here rather than let it poison the gallery.
            results.append({
                "photo": label, "accepted": False,
                "reason": f"face is too small — {face.eye_distance:.0f}px between "
                          f"the eyes, {min_eye:.0f}px needed. Use a closer or "
                          f"higher-resolution photo.",
            })
            continue

        vecs.append(embedder.embed(face.aligned))
        results.append({"photo": label, "accepted": True,
                        "reason": f"enrolled ({face.eye_distance:.0f}px between "
                                  f"the eyes{extra})"})

    if not vecs:
        return {"ok": False,
                "error": f"None of the {len(images)} photograph(s) could be used.",
                "results": results}

    added = gallery.add(name, np.array(vecs, dtype=np.float32), source="web")
    meta = gallery.meta.setdefault(name, {})
    meta.setdefault("enrolledAt", _now_iso())

    # WHO obtained consent, WHEN, and WHAT FOR.
    #
    # The DPDP Act 2023 requires consent at collection for biometric data, and
    # the thing an audit actually asks for is the record of it. Showing a notice
    # on screen and storing nothing meant there was no record at all. Written
    # once and never overwritten: a later top-up of photographs must not quietly
    # restamp the original consent with today's date.
    consent = payload.get("consent") or {}
    if consent and "consent" not in meta:
        meta["consent"] = {
            "by": str(consent.get("by", ""))[:128],
            "at": _now_iso(),
            "purpose": str(consent.get("purpose", ""))[:200],
        }
    gallery.save()

    return {"ok": True, "name": name, "added": added,
            "totalImages": gallery.names.count(name),
            "results": results}


def do_rename(gallery: Gallery, payload: dict) -> dict:
    old = clean_name(payload.get("name"))
    new = clean_name(payload.get("newName"))
    if old not in gallery.people:
        fail(f"{old!r} is not enrolled.")
    merged = new in gallery.people
    n = gallery.rename(old, new)
    gallery.save()
    return {"ok": True, "name": new, "previousName": old,
            "moved": n, "mergedIntoExisting": merged}


def do_remove(gallery: Gallery, payload: dict) -> dict:
    name = clean_name(payload.get("name"))
    if name not in gallery.people:
        # Idempotent on purpose: a double-click must not raise an error the
        # admin then has to interpret.
        return {"ok": True, "name": name, "removed": 0, "wasEnrolled": False}
    removed = gallery.remove(name)
    gallery.save()
    return {"ok": True, "name": name, "removed": removed, "wasEnrolled": True}


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as e:
        fail(f"Malformed request: {e}")

    if config.GALLERY_PATH == config.DEFAULT_DEV_GALLERY:
        fail("GALLERY_PATH is the shared development default. Refusing to touch "
             "it: every organisation must have its own gallery file, or one "
             "client's cameras would match another client's staff.")

    gallery = Gallery(config.GALLERY_PATH)
    action = payload.get("action")

    if action == "list":
        out = do_list(gallery)
    elif action == "add":
        out = do_add(gallery, payload)
    elif action == "rename":
        out = do_rename(gallery, payload)
    elif action == "remove":
        out = do_remove(gallery, payload)
    else:
        fail(f"Unknown action {action!r}. Expected list, add, rename or remove.")

    print(json.dumps(out))


if __name__ == "__main__":
    main()
