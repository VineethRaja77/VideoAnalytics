"""Environment-driven config for the vehicle detection/counting worker."""
import os
import json
from dotenv import load_dotenv

load_dotenv()


def _s(name, default=""):
    return os.getenv(name, default)


def _f(name, default):
    return float(os.getenv(name, str(default)))


def _i(name, default):
    return int(os.getenv(name, str(default)))


def _b(name, default=False):
    return os.getenv(name, str(default)).lower() == "true"


HERE = os.path.dirname(os.path.abspath(__file__))

# ---- Source ----
SOURCE_RTSP = _s("SOURCE_RTSP")
CAMERA_ID = _s("CAMERA_ID")

# ---- Model ----
# RF-DETR Small (Apache-2.0) trained on BMD-45 (Bengaluru Safe City CCTV,
# 3679 cameras, oblique pole-mounted 4-8 m), exported to ONNX.
#
# Export after training with:
#     model.export(output_dir="weights")     -> rfdetr-small.onnx
# The .pt checkpoint is NOT used at runtime; onnxruntime needs the .onnx.
MODEL_PATH = _s("MODEL_PATH", os.path.join(HERE, "weights", "vehicle_rfdetr.onnx"))

CLASSES = ["two_wheeler", "three_wheeler", "car", "van", "lcv",
           "truck", "bus", "bicycle"]

# ---- Inference ----
# Traffic moves fast; 10 fps is the practical floor for reliable tracking. Below
# ~5 fps a vehicle can cross the counting line between two sampled frames and be
# missed entirely.
SAMPLE_FPS = _f("SAMPLE_FPS", 10)
# RF-DETR bakes a FIXED square input into the ONNX graph (512 for Small), so
# detect.py reads it from the model and this is only a fallback.
IMG_SIZE = _i("IMG_SIZE", 512)
CONF = _f("CONF", 0.25)                 # detector floor; per-class filter applied after
IOU_NMS = _f("IOU_NMS", 0.6)

# Class-agnostic NMS. Ordinary NMS only suppresses overlapping boxes of the SAME
# class, so one vehicle can carry a "car" box and a "van" box simultaneously and
# both survive. Agnostic NMS forces one box per object — this is the main fix for
# duplicate/conflicting labels on a single vehicle.
AGNOSTIC_NMS = _b("AGNOSTIC_NMS", True)

# ---- Tracker ----
# supervision's ByteTrack (MIT). The old value was ultralytics' bundled config
# name; kept as a positional arg for signature compatibility but unused.
TRACKER = _s("TRACKER", "bytetrack")

# ---- Calibration profile ----
# Written by train_vehicle_kaggle.py's calibrate() stage: per-class F1-optimal
# confidence thresholds + aspect-ratio/size reject bounds. If absent we fall back
# to the defaults below, which are derived from the BMD-45 label statistics
# (479,536 annotations) rather than guessed.
PROFILE_PATH = _s("PROFILE_PATH", os.path.join(HERE, "vehicle_profile.json"))

# Per-class confidence. Rare classes train under-confident and need a lower bar
# than the abundant ones; a single global threshold either floods you with false
# positives or silently drops every truck.
DEFAULT_CONF = {
    "two_wheeler": 0.40, "three_wheeler": 0.40, "car": 0.40, "van": 0.30,
    "lcv": 0.35, "truck": 0.30, "bus": 0.35, "bicycle": 0.30,
}

# Aspect-ratio (w/h) reject bounds, ~p1/p99 of the BMD-45 distribution.
# DELIBERATELY LOOSE: across 3,679 cameras the per-class AR spread is 3-4x
# (that spread IS the camera-angle variation), and the classes overlap almost
# completely -- car p5-p95 = 0.76-2.05 vs bus 0.62-2.58. So AR can NEVER be used
# to decide a class; it only rejects degenerate/fused boxes.
DEFAULT_AR = {
    "two_wheeler": (0.25, 2.0), "three_wheeler": (0.30, 2.4), "car": (0.45, 3.0),
    "van": (0.40, 2.8), "lcv": (0.28, 3.2), "truck": (0.28, 3.5),
    "bus": (0.30, 3.8), "bicycle": (0.22, 1.8),
}

# Minimum sqrt(w*h) in pixels. Below the size the training data annotates, a
# detection is not trustworthy regardless of its confidence score.
MIN_SIZE_PX = _f("MIN_SIZE_PX", 28)

# ---- Temporal class voting ----
# Detection is per-frame; CLASSIFICATION MUST BE PER-TRACK. Without this the same
# car is re-classified from scratch 10x/second and flickers car->van->lcv.
VOTE_WINDOW = _i("VOTE_WINDOW", 30)         # frames of history kept per track
VOTE_MIN_FRAMES = _i("VOTE_MIN_FRAMES", 5)  # min observations before a class is reported
VOTE_LOCK_FRAMES = _i("VOTE_LOCK_FRAMES", 12)  # after this many, the class is frozen

# How long a track's vote history survives after it stops being detected.
# ByteTrack keeps ids alive across brief occlusions (a vehicle behind a pole, one
# missed frame), so state must NOT be dropped on first absence — doing so resets
# the vote to zero every time and destroys the class lock. Keep this at or above
# the tracker's own track_buffer.
TRACK_GRACE_FRAMES = _i("TRACK_GRACE_FRAMES", 30)

# ---- Which analytics to run ----
# Set by the platform supervisor from the org's LICENSED features. Defaults to
# counting only so a hand-run worker does nothing unexpected.
ENABLED_FEATURES = [f for f in _s("ENABLED_FEATURES", "vehicle_count").split(",") if f.strip()]

# ---- Rule features (all logic, no extra model) ----
# wrong_way: which crossing direction is legal on this camera.
WRONG_WAY_ALLOWED = _s("WRONG_WAY_ALLOWED", "in")

# illegal_parking: stationary inside this polygon for this long.
# Movement tolerance is a FRACTION of the vehicle's own box size, not absolute
# pixels — a distant vehicle moves fewer pixels for the same real distance, so
# a fixed pixel threshold would call every far-away moving vehicle parked.
PARKING_ZONE = _s("PARKING_ZONE", "")
PARKING_SECONDS = _f("PARKING_SECONDS", 120)
PARKING_MOVE_FRACTION = _f("PARKING_MOVE_FRACTION", 0.15)

# congestion: N vehicles in a zone, smoothed, with hysteresis on clearing.
CONGESTION_ZONE = _s("CONGESTION_ZONE", "")
CONGESTION_LIMIT = _i("CONGESTION_LIMIT", 12)
CONGESTION_WINDOW_FRAMES = _i("CONGESTION_WINDOW_FRAMES", 15)

# triple_riding: needs person boxes, which this model does not produce.
# Enable the person module on the same camera to supply them.
TRIPLE_RIDING_PEOPLE = _i("TRIPLE_RIDING_PEOPLE", 3)
TRIPLE_RIDING_OVERLAP = _f("TRIPLE_RIDING_OVERLAP", 0.4)

ALERT_COOLDOWN_S = _f("ALERT_COOLDOWN_S", 60)

# ---- Counting line ----
# "x1,y1,x2,y2" in image space. A track is counted ONCE when its centroid crosses
# this line, with direction. Counting crossings (not presence) is what stops a
# parked vehicle being counted on every frame. Empty = no counting, detect only.
COUNT_LINE = _s("COUNT_LINE", "")

# ---- Output ----
POST_EVENTS = _b("POST_EVENTS", False)
PLATFORM_API = _s("PLATFORM_API", "https://vms.hyperspark.in")
INGEST_KEY = _s("VEHICLE_INGEST_KEY")
SAVE_SNAPSHOTS = _b("SAVE_SNAPSHOTS", True)
SNAPSHOT_DIR = _s("SNAPSHOT_DIR", os.path.join(HERE, "snapshots"))

# Emit a rolling count summary every N seconds (0 = off).
SUMMARY_INTERVAL_S = _f("SUMMARY_INTERVAL_S", 60)


def load_profile() -> dict:
    """Load the calibration profile if the training run produced one."""
    if os.path.exists(PROFILE_PATH):
        try:
            with open(PROFILE_PATH) as f:
                p = json.load(f)
            print(f"[config] loaded calibration profile {PROFILE_PATH}")
            return p
        except Exception as e:  # noqa: BLE001
            print(f"[config] profile unreadable ({e}); using defaults")
    else:
        print(f"[config] no calibration profile at {PROFILE_PATH}; using BMD-45 defaults")
    return {}


def resolve_thresholds() -> tuple[dict, dict, float]:
    """Return (per-class conf, per-class AR bounds, min size px)."""
    prof = load_profile()
    conf = dict(DEFAULT_CONF)
    conf.update(prof.get("conf_threshold", {}))

    ar = dict(DEFAULT_AR)
    min_px = MIN_SIZE_PX
    geo = prof.get("geometry", {})
    for name, g in geo.items():
        lo, hi = g.get("ar_reject_below"), g.get("ar_reject_above")
        if lo is not None and hi is not None:
            ar[name] = (lo, hi)
    if geo:
        floors = [g["min_size_px"] for g in geo.values() if g.get("min_size_px")]
        if floors:
            min_px = min(floors)
    return conf, ar, min_px
