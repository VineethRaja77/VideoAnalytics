"""Environment-driven config for the camera tamper worker.

NO MODEL. This module ships no weights and needs no training — everything is
image statistics. It is the cheapest analytic to run and arguably the most
valuable, because it protects every other analytic: a blinded camera silently
stops producing PPE, vehicle and person events with no other symptom.
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

ENABLED_FEATURES = [f for f in _s("ENABLED_FEATURES", "camera_tamper").split(",") if f.strip()]

# 1 fps is plenty: tampering persists, and a lower rate leaves CPU for the
# analytics that actually need frames.
SAMPLE_FPS = _f("SAMPLE_FPS", 1)

# Frames spent learning this camera's normal blur/edge levels before judging.
WARMUP_FRAMES = _i("WARMUP_FRAMES", 30)
BASELINE_FRAMES = _i("BASELINE_FRAMES", 300)

# Proportional drops from the learned baseline, NOT absolute values — a number
# that means "tampered" on one camera means "normal" on another.
BLUR_DROP = _f("BLUR_DROP", 0.45)        # sharpness lost -> defocused
EDGE_DROP = _f("EDGE_DROP", 0.40)        # detail lost -> covered
SCENE_CHANGE = _f("SCENE_CHANGE", 0.45)  # colour signature diverged -> moved
DARK_LEVEL = _f("DARK_LEVEL", 12.0)      # mean grey below this -> blacked out
FROZEN_DELTA = _f("FROZEN_DELTA", 0.15)  # frame-to-frame diff -> frozen feed

# A truck passing close to the lens looks identical to blocking for a second.
# Requiring the condition to persist is the main false-positive control.
HOLD_SECONDS = _f("HOLD_SECONDS", 5.0)
COOLDOWN_SECONDS = _f("COOLDOWN_SECONDS", 300.0)

PROC_WIDTH = _i("PROC_WIDTH", 320)       # analysis resolution; cheap on purpose

POST_EVENTS = _b("POST_EVENTS", False)
PLATFORM_API = _s("PLATFORM_API", "https://vms.hyperspark.in")
INGEST_KEY = _s("ANALYTICS_INGEST_KEY")
SAVE_SNAPSHOTS = _b("SAVE_SNAPSHOTS", True)
SNAPSHOT_DIR = _s("SNAPSHOT_DIR", os.path.join(HERE, "snapshots"))
