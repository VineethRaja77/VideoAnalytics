"""Environment-driven config for the abandoned/removed object worker.

NO MODEL, NO TRAINING. Dual-background subtraction plus an edge-density test —
OpenCV and numpy only.
"""
import os
from dotenv import load_dotenv

load_dotenv()


def _s(n, d=""):
    return os.getenv(n, d)


def _f(n, d):
    return float(os.getenv(n, str(d)))


def _i(n, d):
    return int(os.getenv(n, str(d)))


def _b(n, d=False):
    return os.getenv(n, str(d)).lower() == "true"


HERE = os.path.dirname(os.path.abspath(__file__))

SOURCE_RTSP = _s("SOURCE_RTSP")
CAMERA_ID = _s("CAMERA_ID")
ENABLED_FEATURES = [f for f in _s("ENABLED_FEATURES", "object_left,object_removed").split(",") if f.strip()]

# 2 fps: an abandoned object is defined by NOT moving, so frame rate buys
# nothing here and costs CPU that the detection modules need.
SAMPLE_FPS = _f("SAMPLE_FPS", 2)

# Frames spent learning the empty scene before judging anything.
WARMUP_FRAMES = _i("WARMUP_FRAMES", 60)

# Two background models at different learning rates. Their difference is what
# isolates "arrived, then stopped moving" from both passing traffic and
# permanent scenery.
SLOW_LR = _f("SLOW_LR", 0.0005)
FAST_LR = _f("FAST_LR", 0.02)

# Blob size as a fraction of frame area. The lower bound rejects speckle; the
# upper bound rejects whole-scene lighting shifts being read as one huge object.
MIN_AREA_FRAC = _f("MIN_AREA_FRAC", 0.0008)
MAX_AREA_FRAC = _f("MAX_AREA_FRAC", 0.25)

# How long an object must sit still before it counts as abandoned. 30s is a
# reasonable default; airports use minutes, a shop counter might use 10s.
PERSIST_SECONDS = _f("PERSIST_SECONDS", 30.0)

# Region no longer static for this long -> object was picked up again.
GONE_SECONDS = _f("GONE_SECONDS", 5.0)

# Proportional edge-density change that decides LEFT vs REMOVED. Below this in
# either direction the case is ambiguous and nothing is reported — a guess
# would be worse than silence.
EDGE_DELTA = _f("EDGE_DELTA", 0.25)

MATCH_IOU = _f("MATCH_IOU", 0.3)
COOLDOWN_SECONDS = _f("COOLDOWN_SECONDS", 300.0)
PROC_WIDTH = _i("PROC_WIDTH", 480)

# Optional polygon "x1,y1,x2,y2,..." limiting where objects are looked for.
# Without it, a parked car or a moved chair is (correctly) a left object.
OBJECT_ZONE = _s("OBJECT_ZONE", "")

POST_EVENTS = _b("POST_EVENTS", False)
PLATFORM_API = _s("PLATFORM_API", "https://vms.hyperspark.in")
INGEST_KEY = _s("ANALYTICS_INGEST_KEY")
SAVE_SNAPSHOTS = _b("SAVE_SNAPSHOTS", True)
SNAPSHOT_DIR = _s("SNAPSHOT_DIR", os.path.join(HERE, "snapshots"))
