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
# ONE GALLERY PER ORGANISATION — never a shared file.
#
# The supervisor passes GALLERY_PATH explicitly as
#     models/face/gallery/<organizationId>.npz
# because a single shared gallery is a tenant breach AND a biometric data
# breach: Client B's cameras would match faces against Client A's enrolled
# staff, and B would learn A's employee names from the event feed.
#
# The default below is a DEVELOPMENT path only. In production the supervisor
# always overrides it, and the worker refuses to start on the default (see the
# check in worker.py) so a misconfigured deployment fails loudly instead of
# silently pooling every client's biometrics into one file.
DEFAULT_DEV_GALLERY = os.path.join(HERE, "gallery", "_dev_only.npz")
GALLERY_PATH = _s("GALLERY_PATH", DEFAULT_DEV_GALLERY)

# How often the running worker re-checks the gallery file for enrolments made
# from the web console. Small enough that a newly enrolled person is recognised
# within seconds; it costs one stat() per interval, not a re-read.
GALLERY_RELOAD_SECONDS = _f("GALLERY_RELOAD_SECONDS", 10)

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

# Two unknown faces this similar within the cooldown are treated as the SAME
# stranger, so they produce one alert instead of one per track.
#
# Higher than MATCH_THRESHOLD on purpose. That threshold decides "is this the
# enrolled Ramesh", where a miss merely means a staff member is reported
# unknown. This one decides "have I already told the operator about this
# person", where a false merge HIDES a second stranger — the more costly error —
# so it demands a clearly stronger match. Measured on real photographs: two
# pictures of the same person score 0.74-0.93, two different people 0.09-0.12,
# so 0.5 sits in empty space between them.
UNKNOWN_SAME_PERSON_SIM = _f("UNKNOWN_SAME_PERSON_SIM", 0.50)

# Below this similarity between consecutive observations of ONE track, the
# track is judged to have been taken over by a different person and everything
# remembered about it is discarded.
#
# Deliberately generous. Consecutive frames of the same face score well above
# 0.9 even through moderate pose and lighting change, while two different
# people score around 0.05, so anything in the middle is safe. Erring low costs
# nothing — a missed hijack is the status quo — while erring high would reset
# a legitimate track every time somebody turned their head.
TRACK_IDENTITY_SIM = _f("TRACK_IDENTITY_SIM", 0.45)

# Emit an event when an UNKNOWN person is confirmed (useful for intrusion), not
# just for recognised staff.
ALERT_ON_UNKNOWN = _b("ALERT_ON_UNKNOWN", True)

# When face recognition may raise alerts, as JSON from the platform:
#   {"face_recognition": {"days":[0,...,6], "from":"18:00", "to":"06:00"}}
# Absent means no time limit. See pipeline/schedule.py.
FEATURE_SCHEDULES = _s("FEATURE_SCHEDULES", "")

# ---- Privacy / DPDP ----
# Facial data is biometric = sensitive personal data under India's DPDP Act 2023:
# explicit consent at collection, purpose limitation, documented retention.
# Snapshots of unrecognised people are the highest-risk artefact here -- keep
# this off unless you have a documented lawful basis for storing them.
SAVE_UNKNOWN_SNAPSHOTS = _b("SAVE_UNKNOWN_SNAPSHOTS", False)
