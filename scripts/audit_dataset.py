#!/usr/bin/env python3
"""
scripts/audit_dataset.py — inspect a COCO dataset BEFORE spending GPU hours on it.

WHY THIS EXISTS
    The fire model wasted ~9.5 h of training to reach mAP50 0.574. The cause was
    visible in the data and nobody looked: one source contributed ~89% of the
    images and was PRE-AUGMENTED (15,345 files from ~6,391 originals), so the
    model largely learned that source's augmentation.

    Licence and image COUNT were verified from the Roboflow API. Data QUALITY
    was not. This closes that gap: run it on every merged dataset and read the
    verdict before starting a run.

WHAT IT CHECKS
    1. DUPLICATE / NEAR-DUPLICATE images (perceptual hash). High rates mean the
       source is pre-augmented, and a big pre-augmented source drowns the others.
    2. SOURCE BALANCE — one dataset dominating the merge.
    3. BOX SIZE distribution. Objects under ~2% of image area are hard at any
       resolution and drag mAP down regardless of training length.
    4. CLASS BALANCE, including classes with too few instances to learn.
    5. ANNOTATION SANITY — zero-area, out-of-bounds and absurd aspect ratios.
    6. TRAIN/VAL LEAKAGE — the same image in both splits inflates every metric
       and is the single most misleading defect a dataset can have.

USAGE
    python scripts/audit_dataset.py <dataset_dir> [more_dirs...]
      dataset_dir contains train/ and valid/ with _annotations.coco.json
"""
import json
import os
import sys
from collections import Counter, defaultdict

try:
    from PIL import Image
except ImportError:
    sys.exit("pip install pillow")


def phash(path, size=8):
    """Tiny perceptual hash: 8x8 greyscale, compared against the mean.

    Deliberately crude. It will not catch a heavy colour-jitter augmentation,
    but it reliably catches flips, crops, rescales and re-encodes — which is
    what "augmented version" on Roboflow actually means.
    """
    try:
        im = Image.open(path).convert("L").resize((size, size), Image.BILINEAR)
    except Exception:  # noqa: BLE001
        return None
    px = list(im.getdata())
    avg = sum(px) / len(px)
    bits = 0
    for i, p in enumerate(px):
        if p > avg:
            bits |= (1 << i)
    return bits


def hamming(a, b):
    return bin(a ^ b).count("1")


def audit_split(root, split, sample_limit=4000):
    d = os.path.join(root, split)
    ann = os.path.join(d, "_annotations.coco.json")
    if not os.path.exists(ann):
        return None
    j = json.load(open(ann))
    cats = {c["id"]: c["name"] for c in j["categories"]}

    imgs = {im["id"]: im for im in j["images"]}
    n_img = len(imgs)

    cls_count = Counter()
    tiny = 0
    bad = 0
    areas = []
    per_img = defaultdict(int)

    for a in j["annotations"]:
        name = cats.get(a["category_id"], "?")
        cls_count[name] += 1
        per_img[a["image_id"]] += 1
        x, y, w, h = a["bbox"]
        im = imgs.get(a["image_id"], {})
        W, H = im.get("width") or 0, im.get("height") or 0
        if w <= 1 or h <= 1:
            bad += 1
            continue
        if W and H:
            frac = (w * h) / (W * H)
            areas.append(frac)
            if frac < 0.02:
                tiny += 1
            if x < -1 or y < -1 or x + w > W + 2 or y + h > H + 2:
                bad += 1
        ar = w / max(h, 1e-6)
        if ar > 25 or ar < 0.04:
            bad += 1

    # Duplicate detection on a sample — hashing 15k images is slow and the rate
    # is what matters, not the exact pairs.
    files = [os.path.join(d, im["file_name"]) for im in list(imgs.values())[:sample_limit]]
    hashes = {}
    dupes = 0
    near = 0
    for f in files:
        h = phash(f)
        if h is None:
            continue
        if h in hashes:
            dupes += 1
            continue
        hit = False
        # Compare against a bounded window: full pairwise is O(n^2).
        for other in list(hashes.keys())[-600:]:
            if hamming(h, other) <= 4:
                near += 1
                hit = True
                break
        if not hit:
            hashes[h] = f

    areas.sort()
    med = areas[len(areas) // 2] if areas else 0.0
    return {
        "split": split, "images": n_img, "boxes": sum(cls_count.values()),
        "classes": dict(cls_count),
        "empty_images": n_img - len(per_img),
        "tiny_boxes_pct": 100.0 * tiny / max(1, len(areas)),
        "median_box_area_pct": 100.0 * med,
        "bad_boxes": bad,
        "sampled": len(files),
        "exact_dupes": dupes, "near_dupes": near,
        "dupe_pct": 100.0 * (dupes + near) / max(1, len(files)),
        "img_names": {im["file_name"] for im in imgs.values()},
    }


def main():
    roots = sys.argv[1:]
    if not roots:
        sys.exit(__doc__)

    print("=" * 74)
    totals = Counter()
    reports = []
    for root in roots:
        name = os.path.basename(root.rstrip("/"))
        print(f"\n### {name}")
        for split in ("train", "valid"):
            r = audit_split(root, split)
            if not r:
                continue
            reports.append((name, r))
            totals[name] += r["images"]
            print(f"  {split:<6} images={r['images']:<6} boxes={r['boxes']:<7} "
                  f"empty={r['empty_images']}")
            print(f"         classes={r['classes']}")
            print(f"         duplicates in sample of {r['sampled']}: "
                  f"exact={r['exact_dupes']} near={r['near_dupes']} "
                  f"({r['dupe_pct']:.1f}%)")
            print(f"         median box area={r['median_box_area_pct']:.2f}% of image | "
                  f"tiny(<2%)={r['tiny_boxes_pct']:.1f}% | malformed={r['bad_boxes']}")

    # ---- cross-source verdicts ----
    print("\n" + "=" * 74)
    print("VERDICT")
    grand = sum(totals.values())
    for name, n in totals.most_common():
        share = 100.0 * n / max(1, grand)
        flag = "  <-- DOMINATES THE MERGE" if share > 60 else ""
        print(f"  {name[:44]:<44} {n:>6} imgs  {share:5.1f}%{flag}")

    problems = []
    for name, r in reports:
        if r["dupe_pct"] > 25:
            problems.append(
                f"{name}/{r['split']}: {r['dupe_pct']:.0f}% duplicate or near-duplicate "
                f"images — this source is PRE-AUGMENTED. RF-DETR augments during "
                f"training, so these mostly teach the augmentation.")
        if r["tiny_boxes_pct"] > 45:
            problems.append(
                f"{name}/{r['split']}: {r['tiny_boxes_pct']:.0f}% of boxes are under 2% of "
                f"the image. Raise RESOLUTION or expect low AP whatever you do.")
        if r["bad_boxes"] > 0.02 * max(1, r["boxes"]):
            problems.append(
                f"{name}/{r['split']}: {r['bad_boxes']} malformed boxes "
                f"(zero-area, out-of-bounds or absurd aspect).")
        for cls, n in r["classes"].items():
            if n < 200 and r["split"] == "train":
                problems.append(
                    f"{name}/train: class '{cls}' has only {n} instances — too few to "
                    f"learn; it will score near zero and drag the mean down.")

    # Leakage is checked across splits of the same source.
    by_src = defaultdict(dict)
    for name, r in reports:
        by_src[name][r["split"]] = r["img_names"]
    for name, splits in by_src.items():
        if "train" in splits and "valid" in splits:
            overlap = splits["train"] & splits["valid"]
            if overlap:
                problems.append(
                    f"{name}: {len(overlap)} images appear in BOTH train and valid. "
                    f"Every reported metric is inflated and cannot be trusted.")

    if problems:
        print("\n  PROBLEMS FOUND:")
        for p in problems:
            print(f"   !! {p}")
        print("\n  Fix these BEFORE training. A 10-hour run cannot repair a dataset.")
    else:
        print("\n  No blocking problems found.")
    print("=" * 74)


if __name__ == "__main__":
    main()
