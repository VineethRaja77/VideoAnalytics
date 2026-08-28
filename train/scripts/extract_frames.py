"""Stage 1+2: extract frames (1 fps) from the site videos AND dedupe in one pass.

The camera is fixed, so consecutive seconds look almost identical. We extract at
1 fps and immediately drop near-duplicates with a perceptual hash (pHash): a frame
is kept only if it's visually different enough from every frame kept so far. This
caps the set at a diverse ~MAX_KEEP images without ever writing 14k junk files.

Output: train/frames/<video>_<sec>.jpg
"""
import os, glob, cv2
from PIL import Image
import imagehash

VIDEOS = sorted(glob.glob("../../data/PPE FILES/*.mp4") + glob.glob("../data/PPE FILES/*.mp4")
                + glob.glob("/home/hyperspark/VMS/VMS/VMS_PRODUCTION/data/PPE FILES/*.mp4"))
OUT = "../frames"
FPS_SAMPLE = 1.0        # frames per second to sample
HASH_DIST = 6           # min pHash Hamming distance to count as "new" (higher=stricter dedupe)
MAX_KEEP = 1500         # hard cap on kept frames (CPU-safe)

os.makedirs(OUT, exist_ok=True)
# de-dup any accidental duplicate paths
VIDEOS = list(dict.fromkeys(os.path.abspath(v) for v in VIDEOS))
print(f"[extract] videos: {[os.path.basename(v) for v in VIDEOS]}")

kept_hashes = []
kept = 0
for vpath in VIDEOS:
    cap = cv2.VideoCapture(vpath)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    stride = max(1, int(round(fps / FPS_SAMPLE)))
    base = os.path.splitext(os.path.basename(vpath))[0]
    idx = 0; sampled = 0; vid_kept = 0
    print(f"[extract] {base}: fps={fps:.1f} stride={stride}")
    while kept < MAX_KEEP:
        if not cap.grab():
            break
        if idx % stride != 0:
            idx += 1; continue
        ok, frame = cap.retrieve(); idx += 1
        if not ok:
            break
        sampled += 1
        # pHash on a small grayscale thumbnail (fast, robust to noise)
        rgb = cv2.cvtColor(cv2.resize(frame, (256, 144)), cv2.COLOR_BGR2RGB)
        h = imagehash.phash(Image.fromarray(rgb))
        if any((h - kh) < HASH_DIST for kh in kept_hashes):
            continue  # near-duplicate of something we already kept
        kept_hashes.append(h)
        sec = int(idx / fps)
        cv2.imwrite(f"{OUT}/{base}_{sec:05d}.jpg", frame)
        kept += 1; vid_kept += 1
        if kept % 100 == 0:
            print(f"[extract] kept={kept} (sampled={sampled} this video)", flush=True)
    cap.release()
    print(f"[extract] {base}: sampled={sampled} kept={vid_kept}")

print(f"\n[extract done] total kept = {kept} diverse frames -> {OUT}/")
