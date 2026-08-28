"""RTSP frame source. Reads MediaMTX's re-published stream over TCP and yields
frames at a target sample rate (not every frame — PPE needs ~1-2 fps)."""
import os
import time
import cv2


class RtspFrameSource:
    def __init__(self, rtsp_url: str, sample_fps: float):
        self.rtsp_url = rtsp_url
        self.min_interval = 1.0 / sample_fps if sample_fps > 0 else 0.0
        # Force TCP (matches the rest of the stack) and a small buffer for low latency.
        os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

    def frames(self):
        cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        last = 0.0
        try:
            while True:
                ok = cap.grab()  # cheap: advance without decoding
                if not ok:
                    print("[stream] read failed; reconnecting in 3s")
                    cap.release()
                    time.sleep(3)
                    cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    continue
                now = time.time()
                if now - last < self.min_interval:
                    continue  # skip until the next sample tick
                ok, frame = cap.retrieve()  # decode only the sampled frame
                if not ok:
                    continue
                last = now
                yield frame
        finally:
            cap.release()
