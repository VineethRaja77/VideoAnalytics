"""Tamper detector tests using synthetically tampered frames.

Every test learns a baseline from a "normal" scene first, then applies a real
transformation (blur, cover, re-aim) and checks the right condition fires — and
just as importantly, that it does NOT fire during normal variation.

Run:  python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.detect import TamperDetector  # noqa: E402


_noise = np.random.default_rng(1234)


def scene(seed=0, w=320, h=240, live=True):
    """A detailed, textured frame standing in for a real camera view.

    `live=True` adds a little fresh sensor noise on every call. That matters:
    a real camera never produces two byte-identical frames, and without the
    noise the frozen-feed detector would (correctly) fire on every test.
    Use live=False to simulate an actually stuck decoder.
    """
    rng = np.random.default_rng(seed)
    # Coherent colour regions, not per-pixel noise. A real scene has large
    # areas of consistent hue; pure random pixels give a hue histogram that is
    # unstable frame to frame, which would make the "moved" check fire on a
    # stationary camera purely because of the fixture.
    img = np.zeros((h, w, 3), np.uint8)
    base = rng.integers(30, 90, 3)
    img[:, :] = base                                   # ground/wall
    img[: h // 3, :] = np.clip(base + 90, 0, 255)      # brighter upper band

    palette = [(200, 90, 60), (60, 180, 90), (70, 90, 200), (200, 190, 60)]
    for i in range(6):
        x = 20 + i * 45
        col = palette[(i + int(seed)) % len(palette)]
        cv2.rectangle(img, (x, 40), (x + 32, 200), col, -1)
    cv2.line(img, (0, 210), (w, 210), (240, 240, 240), 3)
    # Fine texture so edge density and blur scores are meaningful.
    for y in range(0, h, 12):
        cv2.line(img, (0, y), (w, y), (int(base[0]) + 25,) * 3, 1)

    if live:
        # Sensor noise: a real camera never emits two identical frames, and
        # without this the frozen-feed check would fire on every test.
        img = np.clip(
            img.astype(np.int16) + _noise.integers(-4, 5, img.shape), 0, 255
        ).astype(np.uint8)
    return img


def detector(**kw):
    base = dict(warmup_frames=5, hold_seconds=2.0, cooldown_seconds=0.0)
    base.update(kw)
    return TamperDetector(**base)


def warm(det, frames=8, t0=1000.0, seed=0):
    """Feed normal frames so the detector learns this camera's baseline."""
    t = t0
    for i in range(frames):
        det.update(scene(seed), t)
        t += 1.0
    return t


class TestNoFalseAlarms(unittest.TestCase):
    def test_silent_during_warmup(self):
        det = detector()
        for i in range(5):
            self.assertEqual(det.update(scene(), 1000.0 + i), [])

    def test_stable_scene_never_alerts(self):
        det = detector()
        t = warm(det)
        for i in range(30):
            self.assertEqual(det.update(scene(), t + i), [],
                             "a stable scene must never raise tamper")

    def test_mild_brightness_change_is_not_tamper(self):
        """Sun going in, headlights, auto-exposure — all normal."""
        det = detector()
        t = warm(det)
        for i in range(20):
            bright = cv2.convertScaleAbs(scene(), alpha=1.15, beta=25)
            self.assertEqual(det.update(bright, t + i), [])

    def test_brief_obstruction_does_not_alert(self):
        """A truck passing close to the lens looks like blocking for a second.
        The hold time exists precisely to absorb this."""
        det = detector(hold_seconds=5.0)
        t = warm(det)
        covered = np.full((240, 320, 3), 90, np.uint8)
        self.assertEqual(det.update(covered, t), [])
        self.assertEqual(det.update(covered, t + 1.0), [])   # still < hold
        self.assertEqual(det.update(scene(), t + 2.0), [])   # cleared in time


class TestBlocked(unittest.TestCase):
    def test_covered_lens_fires(self):
        det = detector()
        t = warm(det)
        covered = np.full((240, 320, 3), 90, np.uint8)   # flat grey, no edges
        det.update(covered, t)
        out = det.update(covered, t + 3.0)               # held past hold_seconds
        self.assertTrue(any(e["condition"] == "blocked" for e in out), out)

    def test_blacked_out_fires(self):
        det = detector()
        t = warm(det)
        dark = np.full((240, 320, 3), 3, np.uint8)
        det.update(dark, t)
        out = det.update(dark, t + 3.0)
        blocked = [e for e in out if e["condition"] == "blocked"]
        self.assertTrue(blocked)
        self.assertEqual(blocked[0]["reason"], "dark")

    def test_recovery_is_reported(self):
        """An operator must learn the camera came back without watching it."""
        det = detector()
        t = warm(det)
        covered = np.full((240, 320, 3), 90, np.uint8)
        det.update(covered, t)
        det.update(covered, t + 3.0)                    # alert
        out = det.update(scene(), t + 4.0)              # restored
        self.assertTrue(any(e["type"] == "camera_tamper_cleared" for e in out), out)


class TestDefocused(unittest.TestCase):
    def test_heavy_blur_fires(self):
        det = detector()
        t = warm(det)
        blurred = cv2.GaussianBlur(scene(), (31, 31), 0)
        det.update(blurred, t)
        out = det.update(blurred, t + 3.0)
        self.assertTrue(
            any(e["condition"] in ("defocused", "blocked") for e in out), out
        )


class TestMoved(unittest.TestCase):
    @staticmethod
    def _panned(img, dx=110, dy=60):
        """Simulate the camera being physically re-aimed.

        A different colour scheme is NOT a re-aim: the signature is structural,
        so two views with the same geometry are correctly judged the same view.
        Panning changes where every edge sits, which is what actually happens.
        """
        h, w = img.shape[:2]
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        return cv2.warpAffine(img, M, (w, h), borderMode=cv2.BORDER_REFLECT)

    def test_reaimed_camera_fires(self):
        det = detector()
        t = warm(det)
        for i, tt in enumerate((t, t + 3.0, t + 6.0)):
            out = det.update(self._panned(scene()), tt)
            if any(e["condition"] == "moved" for e in out):
                return
        self.fail(f"panning the camera should raise 'moved'; got {out}")

    def test_recolouring_the_same_view_is_not_a_move(self):
        """Guards against a colour-histogram signature sneaking back in: a
        cloud passing over changes colour, not geometry."""
        det = detector()
        t = warm(det, seed=0)
        for i in range(6):
            out = det.update(scene(seed=3), t + i)   # same geometry, new palette
            self.assertFalse(any(e["condition"] == "moved" for e in out), out)


class TestFrozen(unittest.TestCase):
    def test_identical_frames_flag_frozen_feed(self):
        """A live scene always has sensor noise; a byte-identical repeat means
        the decoder is stuck, which no other check would notice."""
        det = detector()
        t = warm(det)
        still = scene(live=False)      # decoder repeating one frame
        # The FIRST still frame still differs from the live frame before it, so
        # the frozen condition only starts on the second one — then it must be
        # held past hold_seconds before alerting.
        det.update(still, t)
        det.update(still, t + 1.0)
        out = det.update(still, t + 6.0)
        self.assertTrue(any(e["condition"] == "signal" for e in out), out)


class TestBaselineIntegrity(unittest.TestCase):
    def test_baseline_does_not_learn_the_tampered_state(self):
        """If the baseline absorbed tampered frames it would drift and the
        alert would silently clear itself while the camera was still blind."""
        det = detector(cooldown_seconds=0.0)
        t = warm(det)
        before = det.status()["baselineEdge"]
        covered = np.full((240, 320, 3), 90, np.uint8)
        for i in range(30):
            det.update(covered, t + 3.0 + i)
        self.assertAlmostEqual(det.status()["baselineEdge"], before, places=6)

    def test_status_reports_warmup(self):
        det = detector()
        self.assertFalse(det.status()["warmedUp"])
        warm(det)
        self.assertTrue(det.status()["warmedUp"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
