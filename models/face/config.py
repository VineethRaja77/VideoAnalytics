"""Environment-driven config for the face recognition worker."""
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

# ---- Models ----
# Detector: YuNet (OpenCV Zoo, MIT — commercial use OK, 233 KB).
DETECTOR_PATH = _s("DETECTOR_PATH",
                   os.path.join(HERE, "weights", "face_detection_yunet_2023mar.onnx"))

# Embedder backend: "auraface" (default) or "dlib" (not yet wired).
# AuraFace glintr100.onnx, sha256 a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60
#   -- verified DIFFERENT from InsightFace antelopev2 (4ab1d6435d...), so it is
#   not a byte copy of the non-commercial weights. fal publishes it Apache-2.0.
#   CAVEAT: provenance questions on the HF discussion are unanswered since
#   Sept 2025. Fine for evaluation; get written confirmation before shipping.
#   Only glintr100.onnx was taken from that repo -- its other four files are
#   InsightFace-derived and non-commercial.
FACE_BACKEND = _s("FACE_BACKEND", "auraface")
EMBEDDER_PATH = _s("EMBEDDER_PATH",
                   os.path.join(HERE, "weights", "auraface_glintr100.onnx"))

# ---- Gallery ----
GALLERY_PATH = _s("GALLERY_PATH", os.path.join(HERE, "gallery", "gallery.npz"))

# ---- Recognition thresholds ----
# Cosine similarity above which a match is accepted. ~0.4 is the usual ArcFace
# starting point. TUNE THIS ON YOUR OWN PEOPLE + a stranger set: raise it to cut
# false accepts (a stranger matched to an employee), lower it to cut false
# rejects (an employee reported unknown). There is no universally correct value.
MATCH_THRESHOLD = _f("MATCH_THRESHOLD", 0.40)

# Best match must beat the runner-up by this margin, else -> unknown. Prevents
# coin-flip assignment between two similar-looking enrolled people.
MATCH_MARGIN = _f("MATCH_MARGIN", 0.05)

# ---- Detection quality gate ----
DETECT_CONF = _f("DETECT_CONF", 0.7)

# Minimum interocular distance in pixels before we even attempt recognition.
# This is the single strongest predictor of whether recognition can work:
#   <20 px  detection only, recognition impossible
#    40 px  works, moderate accuracy
#    80 px+ reliable
# On QMUL-SurvFace (native surveillance faces averaging 24x20 px) the best
# models reach only ~13.8% TPIR @ 10% FPIR -- i.e. wide-angle CCTV faces are NOT
# recognisable by anyone's model. Faces below this are reported as
# "face_detected" without an identity rather than guessed at.
MIN_EYE_DISTANCE_PX = _f("MIN_EYE_DISTANCE_PX", 40)

# ---- Inference ----
SAMPLE_FPS = _f("SAMPLE_FPS", 6)

# ---- Tracking / temporal voting ----
# Faces are associated across frames by IoU (no appearance re-ID) -- enough for
# a gate/entrance camera where people move predictably.
IOU_MATCH = _f("IOU_MATCH", 0.3)
VOTE_WINDOW = _i("VOTE_WINDOW", 30)
VOTE_MIN_FRAMES = _i("VOTE_MIN_FRAMES", 3)
VOTE_LOCK_FRAMES = _i("VOTE_LOCK_FRAMES", 8)
TRACK_GRACE_FRAMES = _i("TRACK_GRACE_FRAMES", 20)

# ---- Output ----
POST_EVENTS = _b("POST_EVENTS", False)
PLATFORM_API = _s("PLATFORM_API", "https://vms.hyperspark.in")
INGEST_KEY = _s("FACE_INGEST_KEY")
SAVE_SNAPSHOTS = _b("SAVE_SNAPSHOTS", True)
SNAPSHOT_DIR = _s("SNAPSHOT_DIR", os.path.join(HERE, "snapshots"))
ALERT_COOLDOWN_S = _f("ALERT_COOLDOWN_S", 60)

# Emit an event when an UNKNOWN person is confirmed (useful for intrusion), not
# just for recognised staff.
ALERT_ON_UNKNOWN = _b("ALERT_ON_UNKNOWN", True)

# ---- Privacy / DPDP ----
# Facial data is biometric = sensitive personal data under India's DPDP Act 2023:
# explicit consent at collection, purpose limitation, documented retention.
# Snapshots of unrecognised people are the highest-risk artefact here -- keep
# this off unless you have a documented lawful basis for storing them.
SAVE_UNKNOWN_SNAPSHOTS = _b("SAVE_UNKNOWN_SNAPSHOTS", False)
