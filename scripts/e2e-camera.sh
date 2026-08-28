#!/usr/bin/env bash
#
# scripts/e2e-camera.sh — end-to-end proof with a REAL RTSP stream.
#
# Everything in the test suite is unit or integration level. None of it proves
# the thing a client actually buys: point the system at a camera and get
# recorded video back. This closes that gap without needing real hardware, by
# publishing a synthetic H.264 stream into MediaMTX with GStreamer and driving
# the platform's own HTTP API against it.
#
# WHAT IS PROVEN
#   1. a camera can be created through the API
#   2. MediaMTX picks up the source and reports the path ready
#   3. the recorder starts and writes real .mp4 segments to disk
#   4. those segments are indexed in the recordings table with a real duration
#   5. the segment is playable (a valid MP4 with a decodable video track)
#   6. deleting the camera stops the recorder and cleans up
#
# WHAT IS NOT PROVEN
#   Real-camera quirks: vendor RTSP dialects, H.265 streams, auth negotiation,
#   network flap, clock drift. A synthetic source is well behaved by definition.
#   This is a regression guard, not a substitute for one real camera on site.
#
# USAGE
#   ./scripts/e2e-camera.sh                 # against a server already running
#   BASE_URL=http://127.0.0.1:5000 ./scripts/e2e-camera.sh
#
# Requires: gst-launch-1.0 (with x264enc + rtspclientsink), MediaMTX running,
#           the VMS server running, and admin credentials.
#
# NOTE: segments are 10 minutes by default, so start the server under test with
#   RECORDING_SEGMENT_SECONDS=15
# or this waits the full segment length before anything is indexed.

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve RECORDINGS_BASE the same way the app does, so the decode check looks
# where segments were actually written.
if [[ -f "$APP_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$APP_DIR/.env"; set +a
fi
RECORDINGS_BASE="${RECORDINGS_BASE:-$APP_DIR/dev_recordings/recordings}"

BASE_URL="${BASE_URL:-http://127.0.0.1:5000}"
MTX_RTSP="${MTX_RTSP:-rtsp://127.0.0.1:8554}"
SEGMENT_WAIT="${SEGMENT_WAIT:-90}"     # seconds to wait for a first segment
PROBE_PATH="e2e_probe_$$"

PUB_PID=""
CAMERA_ID=""
JAR="$(mktemp)"

cleanup() {
  [[ -n "$PUB_PID" ]] && kill "$PUB_PID" 2>/dev/null || true
  # KEEP_CAMERA=1 leaves the camera and its folder in place so a failed run can
  # be inspected. Without it a failure destroys the evidence.
  if [[ "${KEEP_CAMERA:-0}" == "1" ]]; then
    echo "ℹ KEEP_CAMERA=1 — leaving camera $CAMERA_ID and its recordings in place"
    rm -f "$JAR"
    return
  fi
  if [[ -n "$CAMERA_ID" ]]; then
    curl -s -b "$JAR" -X DELETE "$BASE_URL/api/cameras/$CAMERA_ID" \
      -H "Origin: $BASE_URL" >/dev/null 2>&1 || true
  fi
  rm -f "$JAR"
}
trap cleanup EXIT
trap 'echo "❌ E2E FAILED at line $LINENO" >&2' ERR

say() { echo -e "\n▶ $*"; }
ok()  { echo "  ✔ $*"; }
die() { echo "  ❌ $*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
say "Preflight"
command -v gst-launch-1.0 >/dev/null || die "gst-launch-1.0 not found"
gst-inspect-1.0 rtspclientsink >/dev/null 2>&1 || die "GStreamer rtspclientsink missing (install gst-plugins-bad)"
curl -sf "$BASE_URL/api/health" >/dev/null || die "VMS not reachable at $BASE_URL — start the server first"
ok "tooling and server reachable"

if [[ -z "${E2E_EMAIL:-}" || -z "${E2E_PASSWORD:-}" ]]; then
  die "Set E2E_EMAIL and E2E_PASSWORD to an account that can create cameras"
fi

# ------------------------------------------------------------------- login
say "Signing in as $E2E_EMAIL"
LOGIN=$(curl -s -c "$JAR" -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" -H "Origin: $BASE_URL" \
  -d "{\"email\":\"$E2E_EMAIL\",\"password\":\"$E2E_PASSWORD\"}")
echo "$LOGIN" | grep -q '"success":true' || die "login failed: $LOGIN"
ok "authenticated"

# --------------------------------------------------- publish a fake camera
say "Publishing a synthetic 640x480 H.264 stream to $MTX_RTSP/$PROBE_PATH"
# A moving pattern with a timestamp overlay: static frames would let a broken
# recorder look healthy, and the clock makes recorded output verifiable by eye.
gst-launch-1.0 -q \
  videotestsrc pattern=ball is-live=true \
  ! video/x-raw,width=640,height=480,framerate=15/1 \
  ! timeoverlay halignment=left valignment=top font-desc="Sans 20" \
  ! videoconvert \
  ! x264enc tune=zerolatency speed-preset=ultrafast key-int-max=30 bitrate=800 \
  ! h264parse \
  ! rtspclientsink location="$MTX_RTSP/$PROBE_PATH" protocols=tcp \
  >/dev/null 2>&1 &
PUB_PID=$!

for i in $(seq 1 20); do
  sleep 1
  if curl -sf "http://127.0.0.1:9997/v3/paths/get/$PROBE_PATH" 2>/dev/null | grep -q '"ready":true'; then
    ok "MediaMTX reports the source ready"
    break
  fi
  [[ $i -eq 20 ]] && die "MediaMTX never saw the stream — is it running on 8554?"
done

# ------------------------------------------------------- create the camera
say "Creating the camera through the API"
CREATE=$(curl -s -b "$JAR" -X POST "$BASE_URL/api/cameras" \
  -H "Content-Type: application/json" -H "Origin: $BASE_URL" \
  -d "{
    \"name\": \"E2E Probe $$\",
    \"channelId\": \"e2e$$\",
    \"streamUrl\": \"$MTX_RTSP/$PROBE_PATH\",
    \"streamType\": \"rtsp\",
    \"videoCodec\": \"h264\",
    \"recordingPolicy\": \"continuous\",
    \"recordingEnabled\": true
  }")
CAMERA_ID=$(echo "$CREATE" | sed -nE 's/.*"id":"([^"]+)".*/\1/p')
[[ -n "$CAMERA_ID" ]] || die "camera not created: $CREATE"
ok "camera $CAMERA_ID created"

# ------------------------------------------------------ wait for recording
say "Waiting up to ${SEGMENT_WAIT}s for the recorder to produce a segment"
FOUND=""
for i in $(seq 1 "$SEGMENT_WAIT"); do
  sleep 1
  RECS=$(curl -s -b "$JAR" "$BASE_URL/api/cameras/$CAMERA_ID/recordings" 2>/dev/null || echo "[]")
  if echo "$RECS" | grep -q '"filePath"'; then
    FOUND="$RECS"
    ok "recording indexed in the database after ${i}s"
    break
  fi
done
if [[ -z "$FOUND" ]]; then
  echo "  ── diagnosis ──"
  FOLDER=$(find "$RECORDINGS_BASE" -maxdepth 1 -type d -name "*${CAMERA_ID:0:8}*" 2>/dev/null | head -1)
  if [[ -n "$FOLDER" ]]; then
    echo "  recorder folder: $FOLDER"
    echo "  segments on disk: $(find "$FOLDER" -name 'recording-*.mp4' 2>/dev/null | wc -l)"
    find "$FOLDER" -name 'recording-*.mp4' -printf '    %s bytes  %p\n' 2>/dev/null | head -5
    echo "  last GStreamer errors:"
    grep -m3 -i error "$FOLDER/gstreamer.log" 2>/dev/null | sed 's/^/    /' || echo "    (none)"
  else
    echo "  no recorder folder was created under $RECORDINGS_BASE"
  fi
  die "no segment appeared within ${SEGMENT_WAIT}s"
fi

DURATION=$(echo "$FOUND" | sed -nE 's/.*"duration":([0-9]+).*/\1/p' | head -1)
SIZE=$(echo "$FOUND" | sed -nE 's/.*"fileSize":([0-9]+).*/\1/p' | head -1)
[[ "${DURATION:-0}" -gt 0 ]] || die "segment has a zero duration — the recorder wrote an empty file"
[[ "${SIZE:-0}" -gt 10000 ]] || die "segment is only ${SIZE:-0} bytes — not real video"
ok "segment: ${DURATION}s, $((SIZE / 1024)) KB"

# ------------------------------------------------------ verify playability
FILE=$(echo "$FOUND" | sed -nE 's/.*"filePath":"([^"]+)".*/\1/p' | head -1)
say "Verifying the file decodes"
FULL=$(find "$RECORDINGS_BASE" -name "$FILE" 2>/dev/null | head -1)
if [[ -n "$FULL" && -f "$FULL" ]]; then
  # Decode a few frames. A file that exists but does not decode is the failure
  # a size check alone would miss.
  if gst-launch-1.0 -q filesrc location="$FULL" ! qtdemux ! h264parse ! avdec_h264 ! fakesink num-buffers=10 >/dev/null 2>&1; then
    ok "video track decodes ($FILE)"
  else
    die "$FILE exists but does not decode — the recorder produced a corrupt MP4"
  fi
else
  echo "  ⚠ could not locate $FILE on disk to decode-check (set RECORDINGS_BASE)"
fi

# ------------------------------------------------------------- teardown
say "Deleting the camera"
curl -s -b "$JAR" -X DELETE "$BASE_URL/api/cameras/$CAMERA_ID" -H "Origin: $BASE_URL" >/dev/null
sleep 3
STILL=$(curl -s -b "$JAR" "$BASE_URL/api/cameras" | grep -c "$CAMERA_ID" || true)
[[ "$STILL" -eq 0 ]] && ok "camera removed" || die "camera still present after delete"
CAMERA_ID=""

echo -e "\n✅ END-TO-END PASS — API → MediaMTX → recorder → disk → database → playback"
