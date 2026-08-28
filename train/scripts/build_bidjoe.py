"""Stage 4b: convert BIDJOE ppe-14classes into our schema and APPEND to public_labeled.

BIDJOE is the source of the negative classes the other datasets lack — above all
no_glove (9.6k) and glove (8k). We map its ids into our 9-class schema, keep only
images that contain at least one mapped box, and prioritize images that carry a
negative (no_glove/no_shoes/no_helmet/no_safety_vest) so the negatives are well
represented. Person is absent here (comes from the other sources).
"""
import os, glob, shutil, random
random.seed(42)

SRC = "../public_raw/bidjoe"
OUT = "../public_labeled"           # append (do NOT clear)
CAP = 6000
os.makedirs(OUT, exist_ok=True)

# BIDJOE id -> our schema id
# names: 0 glove,1 goggles,2 helmet,3 mask,4 no-suit,5 no_glove,6 no_goggles,
#        7 no_helmet,8 no_mask,9 no_shoes,10 shoes,11 suit,12 no_safety_vest,13 safety_vest
BID_MAP = {0: 5, 2: 1, 5: 6, 7: 2, 9: 8, 10: 7, 12: 4, 13: 3}
NEG_TARGETS = {2, 4, 6, 8}          # our no_helmet/no_vest/no_gloves/no_boots ids

def convert_label(txt):
    out = []
    has_neg = False
    with open(txt) as f:
        for line in f:
            p = line.split()
            if len(p) != 5:
                continue
            src = int(p[0])
            tgt = BID_MAP.get(src)
            if tgt is None:
                continue
            if tgt in NEG_TARGETS:
                has_neg = True
            out.append(f"{tgt} {p[1]} {p[2]} {p[3]} {p[4]}")
    return out, has_neg

pairs = []
for split in ("train", "valid"):
    for txt in glob.glob(f"{SRC}/{split}/labels/*.txt"):
        img = txt.replace("/labels/", "/images/")
        for ext in (".jpg", ".jpeg", ".png"):
            cand = os.path.splitext(img)[0] + ext
            if os.path.exists(cand):
                pairs.append((cand, txt)); break

# prioritize label files that contain a negative, then fill with the rest
converted = []
for img, txt in pairs:
    lines, has_neg = convert_label(txt)
    if lines:
        converted.append((img, lines, has_neg))
random.shuffle(converted)
converted.sort(key=lambda x: not x[2])   # negatives first

written = 0
neg_imgs = 0
for img, lines, has_neg in converted[:CAP]:
    base = "bidjoe_" + os.path.splitext(os.path.basename(img))[0][:40]
    shutil.copy(img, f"{OUT}/{base}.jpg")
    with open(f"{OUT}/{base}.txt", "w") as f:
        f.write("\n".join(lines))
    written += 1
    if has_neg:
        neg_imgs += 1

print(f"[bidjoe] appended {written} images ({neg_imgs} contain a negative) -> {OUT}/")
