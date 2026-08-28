"""Stage 4 (expanded): assemble ~10k public images from 3 datasets -> our 9 classes.

Streaming is used so we only pull as many images as each cap needs (no multi-GB
full download). Each source's classes are mapped into our schema; unmapped classes
(goggles, mask, etc.) are dropped. bbox in every source is COCO [x,y,w,h] pixels.

Sources:
  hiennguyen9874/ppe-detection : helmet, vest, glove, shoes  (POSITIVES incl. gloves/shoes)
  hf-vision/hardhat            : helmet, head->no_helmet, person (helmet NEGATIVES)
  Francesco/construction-safety: helmet, no-helmet, vest, no-vest, person (vest NEGATIVES)
"""
import os
from datasets import load_dataset

OUT = "../public_labeled"
os.makedirs(OUT, exist_ok=True)
# clean any previous build
for f in os.listdir(OUT):
    os.remove(os.path.join(OUT, f))

# each source: (repo, split, cap, name->schema_id map). names are lowercased.
SOURCES = [
    ("hiennguyen9874/ppe-detection", "train", 8000,
        {"helmet": 1, "vest": 3, "glove": 5, "shoes": 7}),
    ("hf-vision/hardhat", "train", 5000,
        {"helmet": 1, "head": 2, "person": 0}),
    ("Francesco/construction-safety-gsnvb", "train", 1300,
        {"helmet": 1, "no-helmet": 2, "vest": 3, "no-vest": 4, "person": 0}),
]

total = 0
total_boxes = 0
for repo, split, cap, cmap in SOURCES:
    print(f"[public] {repo} (cap {cap}) ...", flush=True)
    ds = load_dataset(repo, split=split, streaming=True)
    # some sources store category as ClassLabel (needs names), others as strings
    feats = ds.features
    classlabel_names = None
    try:
        classlabel_names = feats["objects"]["category"].feature.names
    except Exception:
        classlabel_names = None
    tag = repo.split("/")[-1][:6]
    written = 0
    for i, ex in enumerate(ds):
        if written >= cap:
            break
        try:
            img = ex["image"].convert("RGB")
        except Exception:
            continue
        W, H = img.size
        o = ex["objects"]
        cats = o["category"]
        lines = []
        for bbox, cat in zip(o["bbox"], cats):
            name = (classlabel_names[cat] if classlabel_names is not None else cat)
            tgt = cmap.get(str(name).lower())
            if tgt is None:
                continue
            x, y, bw, bh = bbox
            cx = (x + bw / 2) / W; cy = (y + bh / 2) / H
            nw = bw / W; nh = bh / H
            if nw <= 0 or nh <= 0 or nw > 1.5 or nh > 1.5:
                continue
            lines.append(f"{tgt} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
        if not lines:
            continue
        base = f"pub_{tag}_{i:06d}"
        img.save(f"{OUT}/{base}.jpg", quality=90)
        with open(f"{OUT}/{base}.txt", "w") as f:
            f.write("\n".join(lines))
        written += 1; total_boxes += len(lines)
        if written % 500 == 0:
            print(f"[public]   {repo}: {written}/{cap}", flush=True)
    print(f"[public] {repo}: wrote {written}")
    total += written

print(f"[public done] {total} images, {total_boxes} boxes -> {OUT}/")
