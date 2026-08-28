"""Stage 5: merge auto-labeled site frames + public dataset, split train/val.

Combines train/frames_labeled (site) and train/public_labeled (public negatives)
into the YOLO layout under train/dataset with a deterministic 85/15 split.
Images with an empty label file are still useful as background negatives, but we
keep at most a small fraction of them so they don't dominate.
"""
import os, glob, random, shutil

SRC_DIRS = ["../frames_labeled", "../public_labeled"]
DST = "../dataset"
VAL_RATIO = 0.15
MAX_EMPTY_RATIO = 0.10   # cap background (no-object) images at 10% of the set
random.seed(42)

for sub in ["images/train", "images/val", "labels/train", "labels/val"]:
    d = os.path.join(DST, sub)
    os.makedirs(d, exist_ok=True)
    for f in glob.glob(os.path.join(d, "*")):
        os.remove(f)  # clean previous build

pairs = []
for sd in SRC_DIRS:
    for txt in glob.glob(os.path.join(sd, "*.txt")):
        img = txt[:-4] + ".jpg"
        if os.path.exists(img):
            pairs.append((img, txt))

random.shuffle(pairs)

# cap empty-label images
non_empty = [(i, t) for (i, t) in pairs if os.path.getsize(t) > 0]
empty = [(i, t) for (i, t) in pairs if os.path.getsize(t) == 0]
max_empty = int(len(non_empty) * MAX_EMPTY_RATIO)
empty = empty[:max_empty]
pairs = non_empty + empty
random.shuffle(pairs)

n_val = int(len(pairs) * VAL_RATIO)
val = set(range(n_val))

counts = {"train": 0, "val": 0}
for i, (img, txt) in enumerate(pairs):
    split = "val" if i in val else "train"
    base = os.path.basename(img)
    shutil.copy(img, os.path.join(DST, "images", split, base))
    shutil.copy(txt, os.path.join(DST, "labels", split, base[:-4] + ".txt"))
    counts[split] += 1

print(f"[merge] non-empty={len(non_empty)} empty-kept={len(empty)}")
print(f"[merge done] train={counts['train']} val={counts['val']} -> {DST}")
