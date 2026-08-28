"""Environment-driven config for the person analytics worker.

ONE worker serves up to seven features. ENABLED_FEATURES is supplied by the
platform supervisor and contains only what the organisation is LICENSED for —
an unlicensed rule is never constructed, so it costs nothing at runtime.
"""
import os
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

# ---- Which analytics to run ----
# Set by the supervisor from the org's licensed features. Empty = run nothing,
# which is the safe default: a misconfigured worker must not invent analytics.
ENABLED_FEATURES = [f for f in _s("ENABLED_FEATURES", "").split(",") if f.strip()]

# ---- Model ----
# RF-DETR Small COCO-pretrained (Apache-2.0), exported to ONNX. No training:
# `person` is COCO class 1 in the stock checkpoint.
MODEL_PATH = _s("MODEL_PATH", os.path.join(HERE, "weights", "person_rfdetr.onnx"))

# ---- Inference ----
# 6 fps is enough for people, who move far slower than vehicles, and it leaves
# CPU headroom for several cameras on one box.
SAMPLE_FPS = _f("SAMPLE_FPS", 6)
CONF = _f("CONF", 0.40)
IOU_NMS = _f("IOU_NMS", 0.6)

# Below this box height a person is too small to track reliably; the dwell and
# crossing rules then produce noise rather than events.
MIN_HEIGHT_PX = _f("MIN_HEIGHT_PX", 40)
# Generous on purpose — the fall rule depends on wide boxes being kept.
MAX_ASPECT = _f("MAX_ASPECT", 2.5)

# ---- Tracking ----
# Longer than the vehicle module: people loiter and occlude each other, and a
# lost id resets every dwell timer that depends on it.
LOST_TRACK_BUFFER = _i("LOST_TRACK_BUFFER", 60)
TRACK_GRACE_FRAMES = _i("TRACK_GRACE_FRAMES", 60)

# ---- Zones (image-space polygons "x1,y1,x2,y2,x3,y3,...") ----
# INTRUSION_ZONE doubles as the default for the other zone rules so a simple
# deployment configures one polygon. Empty polygon = whole frame.
INTRUSION_ZONE = _s("INTRUSION_ZONE", "")
LOITER_ZONE = _s("LOITER_ZONE", "")
CROWD_ZONE = _s("CROWD_ZONE", "")
QUEUE_ZONE = _s("QUEUE_ZONE", "")

# ---- Lines ("x1,y1,x2,y2") ----
COUNT_LINE = _s("COUNT_LINE", "")
TAILGATE_LINE = _s("TAILGATE_LINE", "")

# ---- Per-feature thresholds ----
# intrusion: frames inside before alerting (kills corner-clipping false alarms)
INTRUSION_MIN_FRAMES = _i("INTRUSION_MIN_FRAMES", 3)

# people_count
COUNT_SUMMARY_INTERVAL_S = _f("COUNT_SUMMARY_INTERVAL_S", 60)

# loitering: dwell in SECONDS, so the threshold is independent of SAMPLE_FPS
LOITER_SECONDS = _f("LOITER_SECONDS", 60)

# crowd_density: alert above LIMIT people, smoothed over a rolling window so a
# single missed detection does not flap the alert on and off
CROWD_LIMIT = _i("CROWD_LIMIT", 10)
CROWD_WINDOW_FRAMES = _i("CROWD_WINDOW_FRAMES", 15)

# queue_dwell
QUEUE_SUMMARY_INTERVAL_S = _f("QUEUE_SUMMARY_INTERVAL_S", 60)

# tailgating: N people crossing within W seconds. Vision half only — pair it
# with a door/badge event to call it a real violation.
TAILGATE_WINDOW_S = _f("TAILGATE_WINDOW_S", 3)
TAILGATE_PEOPLE = _i("TAILGATE_PEOPLE", 2)

# fall: box-geometry heuristic. Aspect w/h above FALL_ASPECT plus a downward
# jump of FALL_DROP_FRACTION x the track's own height, held for FALL_HOLD_S.
FALL_ASPECT = _f("FALL_ASPECT", 1.0)
FALL_DROP_FRACTION = _f("FALL_DROP_FRACTION", 0.15)
FALL_HOLD_S = _f("FALL_HOLD_S", 2.0)

# ---- Alerting ----
ALERT_COOLDOWN_S = _f("ALERT_COOLDOWN_S", 60)

# ---- Output ----
POST_EVENTS = _b("POST_EVENTS", False)
PLATFORM_API = _s("PLATFORM_API", "https://vms.hyperspark.in")
INGEST_KEY = _s("ANALYTICS_INGEST_KEY")
SAVE_SNAPSHOTS = _b("SAVE_SNAPSHOTS", True)
SNAPSHOT_DIR = _s("SNAPSHOT_DIR", os.path.join(HERE, "snapshots"))

# Person images are personal data under India's DPDP Act. Snapshots are on by
# default only for ALERT-type events (intrusion, loitering, fall, tailgating);
# routine counting never writes an image.
SNAPSHOT_EVENTS = set(
    _s("SNAPSHOT_EVENTS", "intrusion,loitering,fall,tailgating").split(",")
)
