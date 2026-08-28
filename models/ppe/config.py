"""Environment-driven config for the PPE compliance worker."""
import os
import json

HERE = os.path.dirname(os.path.abspath(__file__))
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


# ---- Source ----
SOURCE_RTSP = _s("SOURCE_RTSP")
CAMERA_ID = _s("CAMERA_ID")

# ---- Model ----
# ONE RF-DETR model (Apache-2.0) exported to ONNX detects people AND every PPE
# class in a single pass. It replaces the old YOLO-pose + two-model ensemble,
# which was AGPL-3.0 and could not ship in a closed-source product.
#
# Export it with:  train/train_ppe_rfdetr_kaggle.py  (does it automatically)
# The .pth checkpoint is NOT used at runtime; onnxruntime needs the .onnx.
MODEL_PATH = _s("MODEL_PATH", os.path.join(HERE, "weights", "ppe_rfdetr.onnx"))

# Order MUST match the training script's CLASSES list exactly — the model emits
# class INDICES, so a reordering here silently mislabels every detection.
CLASSES = ["person", "helmet", "no_helmet", "vest", "no_vest",
           "gloves", "no_gloves", "boots", "no_boots"]

# ---- Inference ----
SAMPLE_FPS = _f("SAMPLE_FPS", 3)
PERSON_CONF = _f("PERSON_CONF", 0.4)
PPE_CONF = _f("PPE_CONF", 0.35)
IOU_NMS = _f("IOU_NMS", 0.5)
# Input resolution is READ FROM THE ONNX FILE, not set here: the model was
# exported at 672x672 and feeding it anything else silently loses accuracy.

# Per-class floors. Measured on the val set of the shipped model:
#   vest 0.77 AP | person 0.63 | boots 0.59 | helmet 0.56
#   no_vest 0.41 | no_helmet 0.30 | no_boots 0.14  <-- negatives are much weaker
# The negatives need a HIGHER bar, not a lower one: a false "no_helmet" is a
# false accusation against a worker, while a missed one is only a missed alert.
PER_CLASS_CONF = json.loads(_s("PER_CLASS_CONF", json.dumps({
    "person": 0.40,
    "helmet": 0.35, "vest": 0.35, "boots": 0.40, "gloves": 0.45,
    "no_helmet": 0.55, "no_vest": 0.55, "no_boots": 0.75, "no_gloves": 0.65,
})))

# ---- Visibility (a keypoint counts as visible above this confidence) ----
KP_CONF = _f("KP_CONF", 0.5)

# ---- Zone / line trigger ----
# Only analyze a worker after they cross into the restricted area. Define the
# line as two image-space points "x1,y1,x2,y2"; a worker is "inside" when their
# feet (or bbox bottom) are below the line. Empty = analyze everyone (no gate).
ZONE_LINE = _s("ZONE_LINE", "")   # e.g. "0,400,1280,400"

# ---- Temporal verification ----
TEMPORAL_WINDOW = _i("TEMPORAL_WINDOW", 30)     # frames kept per track
TEMPORAL_MIN_FRAMES = _i("TEMPORAL_MIN_FRAMES", 12)  # min observations before deciding
VIOLATION_RATIO = _f("VIOLATION_RATIO", 0.7)    # fraction of frames missing PPE -> violation
ALERT_COOLDOWN_S = _f("ALERT_COOLDOWN_S", 60)   # don't re-alert the same track+item within this

# ---- PPE required set (which items to enforce when the body part is visible) ----
# Keys are logical items; values are the detector class names.
#   REQUIRED_PPE  = classes that PROVE the item is worn (positive)
#   NEGATIVE_PPE  = classes that PROVE the item is absent (e.g. "NO-Hardhat")
# Any expected item with NO configured classes is reported "unknown" (the loaded
# detector can't judge it) instead of a false violation. The defaults below match
# the bundled hardhat model {Hardhat, NO-Hardhat}; when a full PPE model is
# trained, extend these maps (and PPE_MODEL) via env to cover vest/gloves/boots.
REQUIRED_PPE = json.loads(
    _s(
        "REQUIRED_PPE",
        json.dumps(
            {
                "helmet": ["helmet"],
                "vest": ["vest"],
                "boots": ["boots"],
                "gloves": ["gloves"],
            }
        ),
    )
)

NEGATIVE_PPE = json.loads(
    _s(
        "NEGATIVE_PPE",
        json.dumps(
            {
                "helmet": ["no_helmet"],
                "vest": ["no_vest"],
                "boots": ["no_boots"],
                "gloves": ["no_gloves"],
            }
        ),
    )
)

# Items for which "detector saw the body part but detected no PPE there" should be
# treated as a MISSING violation even without an explicit "NO-" class. Leave empty
# for items whose detector is unreliable on the footage (a miss would falsely flag
# the worker). Helmet already gets "missing" from its explicit NO-Hardhat class, so
# it doesn't need to be listed here.
ABSENCE_MISSING = set(json.loads(_s("ABSENCE_MISSING", "[]")))

# ---- Output ----
POST_EVENTS = _b("POST_EVENTS", False)
PLATFORM_API = _s("PLATFORM_API", "https://vms.hyperspark.in")
INGEST_KEY = _s("PPE_INGEST_KEY")   # shared secret for the platform events endpoint
SAVE_SNAPSHOTS = _b("SAVE_SNAPSHOTS", True)
SNAPSHOT_DIR = _s("SNAPSHOT_DIR", "snapshots")
