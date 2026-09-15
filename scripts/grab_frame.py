#!/usr/bin/env python3
"""Grab ONE still frame from an RTSP stream and write it as JPEG.

WHY THIS EXISTS
    Drawing an intrusion zone needs a picture of what the camera actually sees,
    in the SAME pixel coordinate system the analytics worker reads. The worker
    opens the stream with cv2.VideoCapture and never resizes, so this uses
    cv2.VideoCapture too. A snapshot taken through a different decoder or a
    scaled preview would produce a polygon in the wrong coordinate space, and
    the zone would silently sit somewhere else in the frame.

    No system ffmpeg binary is required: opencv-python bundles its own.

INPUT (environment, not argv — argv is visible to every user via `ps`, and an
       RTSP URL can carry credentials)
    GRAB_RTSP   stream URL
    GRAB_OUT    file to write

OUTPUT
    stdout : one JSON object {"ok":true,"width":W,"height":H} on success
    exit 0 on success, non-zero with a SPECIFIC reason on stderr otherwise.
    "Failed to grab frame" tells an installer nothing; "could not open stream"
    versus "opened but produced no frame" points at the network vs the codec.
"""
import json
import os
import sys

# Must be set before cv2 builds its capture: UDP RTSP silently produces torn
# frames on any congested site network, and a torn frame is a misleading
# backdrop to draw a security zone on.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS",
                      "rtsp_transport;tcp|stimeout;8000000")

import cv2  # noqa: E402


def main() -> None:
    url = os.environ.get("GRAB_RTSP", "").strip()
    out = os.environ.get("GRAB_OUT", "").strip()
    if not url or not out:
        sys.exit("GRAB_RTSP and GRAB_OUT must both be set")

    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        sys.exit("could not open stream — the camera is offline, the URL or "
                 "credentials are wrong, or MediaMTX is not publishing this path")

    # Read a short run rather than one frame. A capture that joins mid-GOP
    # decodes its first frames from an incomplete reference and they come back
    # grey, green or smeared; keeping the LAST of a few reads costs ~1 s and
    # avoids handing the operator a broken picture to draw on.
    frame = None
    for _ in range(12):
        ok, f = cap.read()
        if ok and f is not None and f.size:
            frame = f
    cap.release()

    if frame is None:
        sys.exit("stream opened but produced no decodable frame — the camera is "
                 "connected but sending an unsupported codec, or the stream has "
                 "no video track")

    h, w = frame.shape[:2]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    if not cv2.imwrite(out, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85]):
        sys.exit(f"decoded a {w}x{h} frame but could not write {out} — check "
                 f"permissions and free disk space")

    print(json.dumps({"ok": True, "width": w, "height": h}))


if __name__ == "__main__":
    main()
