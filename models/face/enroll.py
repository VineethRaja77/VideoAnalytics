#!/usr/bin/env python3
"""Enrol people into the gallery.

No training happens here. Enrolment = detect the face, align it, compute its
512-d embedding, and append that row to the gallery. Adding a person takes about
a second; removing one is deleting rows. The recognition model never changes.

Layout — one folder per person:

    people/
      ramesh/   img1.jpg img2.jpg img3.jpg
      priya/    img1.jpg img2.jpg

Usage:
    python enroll.py --dir people/                 # enrol everyone
    python enroll.py --dir people/ --replace       # rebuild from scratch
    python enroll.py --remove ramesh
    python enroll.py --list

Use 3-5 images per person with mild pose/lighting variation, ideally captured on
the same camera that will do the recognising. Enrolling only a passport-style
photo and then matching against an oblique CCTV view is the most common cause of
poor real-world accuracy.
"""
import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
from pipeline.detect import FaceDetector  # noqa: E402
from pipeline.embed import build_embedder  # noqa: E402
from pipeline.gallery import Gallery  # noqa: E402

EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


def enrol_dir(root, gallery, detector, embedder, min_eye) -> None:
    people = sorted(d for d in os.listdir(root)
                    if os.path.isdir(os.path.join(root, d)))
    if not people:
        sys.exit(f"no person folders found in {root}")

    for person in people:
        pdir = os.path.join(root, person)
        imgs = sorted(f for f in os.listdir(pdir) if f.lower().endswith(EXTS))
        vecs, skipped = [], []
        for fn in imgs:
            path = os.path.join(pdir, fn)
            frame = cv2.imread(path)
            if frame is None:
                skipped.append((fn, "unreadable"))
                continue
            faces = detector.detect(frame)
            if not faces:
                skipped.append((fn, "no face detected"))
                continue
            # Enrolment images should contain exactly one subject. If several
            # faces appear we take the largest, but say so — silently enrolling
            # a bystander poisons that person's gallery entry permanently.
            faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
                       reverse=True)
            if len(faces) > 1:
                print(f"    ! {fn}: {len(faces)} faces, using the largest")
            face = faces[0]
            if face.eye_distance < min_eye:
                skipped.append((fn, f"eye distance {face.eye_distance:.0f}px "
                                    f"< {min_eye:.0f}px"))
                continue
            vecs.append(embedder.embed(face.aligned))

        if vecs:
            n = gallery.add(person, np.array(vecs, dtype=np.float32), source=pdir)
            print(f"  {person:<20} enrolled {n} image(s)")
        else:
            print(f"  {person:<20} NOTHING ENROLLED")
        for fn, why in skipped:
            print(f"    skipped {fn}: {why}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", help="root folder containing one subfolder per person")
    ap.add_argument("--remove", help="remove a person from the gallery")
    ap.add_argument("--list", action="store_true", help="list enrolled people")
    ap.add_argument("--replace", action="store_true",
                    help="wipe the gallery before enrolling")
    ap.add_argument("--min-eye", type=float, default=config.MIN_EYE_DISTANCE_PX)
    a = ap.parse_args()

    gallery = Gallery(config.GALLERY_PATH)

    if a.list:
        if not len(gallery):
            print("gallery is empty")
            return
        print(f"{len(gallery.people)} people, {len(gallery)} embeddings "
              f"({config.GALLERY_PATH})")
        for p in gallery.people:
            m = gallery.meta.get(p, {})
            print(f"  {p:<20} {gallery.names.count(p)} embeddings"
                  f"  {m.get('sources', [''])[0] if m.get('sources') else ''}")
        return

    if a.remove:
        n = gallery.remove(a.remove)
        gallery.save()
        print(f"removed {a.remove}: {n} embeddings dropped")
        return

    if not a.dir:
        ap.error("give --dir, --remove or --list")
    if not os.path.isdir(a.dir):
        sys.exit(f"not a directory: {a.dir}")

    if a.replace:
        gallery.vectors = np.zeros((0, 512), dtype=np.float32)
        gallery.names, gallery.meta = [], {}
        print("gallery wiped")

    detector = FaceDetector(config.DETECTOR_PATH, config.DETECT_CONF)
    embedder = build_embedder(config.FACE_BACKEND, config.EMBEDDER_PATH)
    print(f"[enrol] backend={embedder.name} min_eye_distance={a.min_eye:.0f}px")

    enrol_dir(a.dir, gallery, detector, embedder, a.min_eye)
    gallery.save()
    print(f"\n[enrol] gallery: {len(gallery.people)} people, "
          f"{len(gallery)} embeddings -> {config.GALLERY_PATH}")


if __name__ == "__main__":
    main()
