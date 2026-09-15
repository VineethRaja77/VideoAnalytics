"""Tests for the web enrolment bridge.

The recognition maths is covered by test_gallery.py. What matters here is
everything AROUND it, because that is what a client admin actually hits:

  - the shared-gallery refusal (a tenant/biometric breach if it ever passes)
  - per-photo rejection reasons (a silently-accepted bad photo means the person
    is never recognised and nobody knows why)
  - names that would be truncated by the gallery's fixed-width dtype
  - remove being idempotent

The detector and embedder are stubbed so these run without weights and without
a real photograph: this file is testing the bridge, not the model.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE = os.path.dirname(HERE)
sys.path.insert(0, MODULE)

import config  # noqa: E402


def jpeg_b64(w=200, h=200) -> str:
    img = np.full((h, w, 3), 127, np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


def run_bridge(payload: dict, gallery_path: str) -> dict:
    """Call enroll_api.py exactly the way the Node server does."""
    env = {**os.environ, "GALLERY_PATH": gallery_path}
    proc = subprocess.run(
        [sys.executable, os.path.join(MODULE, "enroll_api.py")],
        input=json.dumps(payload), capture_output=True, text=True, env=env,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip().split("\n")[-1])


class BridgeGuards(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.gallery = os.path.join(self.dir, "org-a.npz")

    def test_refuses_the_shared_development_gallery(self):
        """One gallery for every client is a tenant AND a biometric breach."""
        out = run_bridge({"action": "list"}, config.DEFAULT_DEV_GALLERY)
        self.assertFalse(out["ok"])
        self.assertIn("own gallery", out["error"])

    def test_empty_gallery_lists_cleanly(self):
        out = run_bridge({"action": "list"}, self.gallery)
        self.assertEqual(out, {"ok": True, "people": [], "embeddings": 0})

    def test_unknown_action_is_refused_by_name(self):
        out = run_bridge({"action": "wipe"}, self.gallery)
        self.assertFalse(out["ok"])
        self.assertIn("wipe", out["error"])

    def test_remove_is_idempotent(self):
        out = run_bridge({"action": "remove", "name": "nobody"}, self.gallery)
        self.assertTrue(out["ok"])
        self.assertFalse(out["wasEnrolled"])

    def test_name_longer_than_the_dtype_is_refused(self):
        """U128 TRUNCATES on save — two people would merge into one entry."""
        out = run_bridge({"action": "add", "name": "x" * 129,
                          "images": [jpeg_b64()]}, self.gallery)
        self.assertFalse(out["ok"])
        self.assertIn("truncated", out["error"])

    def test_blank_name_is_refused(self):
        out = run_bridge({"action": "add", "name": "   ",
                          "images": [jpeg_b64()]}, self.gallery)
        self.assertFalse(out["ok"])

    def test_no_photos_is_refused(self):
        out = run_bridge({"action": "add", "name": "ramesh", "images": []},
                         self.gallery)
        self.assertFalse(out["ok"])


class StubbedEnrolment(unittest.TestCase):
    """In-process, with a stub detector/embedder, to exercise do_add itself."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.gallery_path = os.path.join(self.dir, "org-b.npz")

        import enroll_api
        import pipeline.detect as detect_mod
        import pipeline.embed as embed_mod
        self.enroll_api = enroll_api
        self.detect_mod = detect_mod
        self.embed_mod = embed_mod
        self._real_detector = detect_mod.FaceDetector
        self._real_builder = embed_mod.build_embedder
        self._real_det_path = config.DETECTOR_PATH
        self._real_emb_path = config.EMBEDDER_PATH
        # The weights-present check must pass; any existing file will do.
        config.DETECTOR_PATH = config.EMBEDDER_PATH = __file__

    def tearDown(self):
        self.detect_mod.FaceDetector = self._real_detector
        self.embed_mod.build_embedder = self._real_builder
        config.DETECTOR_PATH = self._real_det_path
        config.EMBEDDER_PATH = self._real_emb_path

    def _stub(self, eye_px, n_faces=1):
        class Face:
            def __init__(self, i):
                self.bbox = (0, 0, 100 - i, 100 - i)
                self.aligned = np.zeros((112, 112, 3), np.uint8)
                self.eye_distance = eye_px

        class Detector:
            def __init__(self, *a, **k):
                pass

            def detect(self, frame):
                return [Face(i) for i in range(n_faces)]

        class Embedder:
            name = "stub"

            def embed(self, aligned):
                v = np.ones(512, np.float32)
                return v / np.linalg.norm(v)

        self.detect_mod.FaceDetector = Detector
        self.embed_mod.build_embedder = lambda *a, **k: Embedder()

    def _gallery(self):
        from pipeline.gallery import Gallery
        return Gallery(self.gallery_path)

    def test_small_face_is_rejected_with_the_measurement(self):
        """The commonest cause of 'enrolled but never recognised'."""
        self._stub(eye_px=18)
        out = self.enroll_api.do_add(self._gallery(),
                                     {"name": "ramesh", "images": [jpeg_b64()]})
        self.assertFalse(out["ok"])
        self.assertIn("18px", out["results"][0]["reason"])
        self.assertIn("too small", out["results"][0]["reason"])
        # Nothing was written — a rejected enrolment must not create a person.
        self.assertEqual(self._gallery().people, [])

    def test_good_photos_enrol_and_persist(self):
        self._stub(eye_px=90)
        out = self.enroll_api.do_add(
            self._gallery(), {"name": "ramesh", "images": [jpeg_b64(), jpeg_b64()]})
        self.assertTrue(out["ok"])
        self.assertEqual(out["added"], 2)
        self.assertEqual(self._gallery().people, ["ramesh"])
        self.assertTrue(all(r["accepted"] for r in out["results"]))

    def test_extra_faces_in_the_photo_are_reported(self):
        """Silently enrolling a bystander poisons that person permanently."""
        self._stub(eye_px=90, n_faces=3)
        out = self.enroll_api.do_add(self._gallery(),
                                     {"name": "priya", "images": [jpeg_b64()]})
        self.assertTrue(out["ok"])
        self.assertIn("3 faces present", out["results"][0]["reason"])

    def test_partial_success_keeps_the_good_photos(self):
        self._stub(eye_px=90)
        out = self.enroll_api.do_add(
            self._gallery(),
            {"name": "amit", "images": [jpeg_b64(), "not base64 at all!!"]})
        self.assertTrue(out["ok"])
        self.assertEqual(out["added"], 1)
        self.assertFalse(out["results"][1]["accepted"])

    def test_non_image_bytes_are_rejected_not_crashed(self):
        self._stub(eye_px=90)
        blob = base64.b64encode(b"this is a text file").decode()
        out = self.enroll_api.do_add(self._gallery(),
                                     {"name": "amit", "images": [blob]})
        self.assertFalse(out["ok"])
        self.assertIn("not a JPEG", out["results"][0]["reason"])

    def test_two_orgs_never_share_a_gallery(self):
        self._stub(eye_px=90)
        a = os.path.join(self.dir, "org-a.npz")
        b = os.path.join(self.dir, "org-c.npz")
        from pipeline.gallery import Gallery
        self.enroll_api.do_add(Gallery(a), {"name": "alice", "images": [jpeg_b64()]})
        self.enroll_api.do_add(Gallery(b), {"name": "bob", "images": [jpeg_b64()]})
        self.assertEqual(Gallery(a).people, ["alice"])
        self.assertEqual(Gallery(b).people, ["bob"])


if __name__ == "__main__":
    unittest.main(verbosity=2)


class GalleryHotReload(unittest.TestCase):
    """A running worker must adopt enrolments without being restarted.

    Restarting drops every track and blanks the camera for several seconds on
    every camera in the organisation — unacceptable as the cost of adding one
    person from the web console.
    """

    def setUp(self):
        from pipeline.gallery import Gallery
        self.Gallery = Gallery
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "org.npz")

    def _vec(self, seed):
        rng = np.random.default_rng(seed)
        v = rng.normal(size=512).astype(np.float32)
        return v / np.linalg.norm(v)

    def test_new_person_is_picked_up_without_a_restart(self):
        reader = self.Gallery(self.path)          # the worker's long-lived copy
        self.assertEqual(reader.people, [])

        writer = self.Gallery(self.path)          # the web enrolment
        writer.add("ramesh", self._vec(1))
        writer.save()

        self.assertTrue(reader.reload_if_changed())
        self.assertEqual(reader.people, ["ramesh"])
        # A second call with no further change must not re-read.
        self.assertFalse(reader.reload_if_changed())

    def test_removal_is_picked_up_too(self):
        writer = self.Gallery(self.path)
        writer.add("ramesh", self._vec(1))
        writer.add("priya", self._vec(2))
        writer.save()

        reader = self.Gallery(self.path)
        self.assertEqual(reader.people, ["priya", "ramesh"])

        writer.remove("ramesh")
        writer.save()
        self.assertTrue(reader.reload_if_changed())
        self.assertEqual(reader.people, ["priya"])

    def test_a_missing_file_never_wipes_a_loaded_gallery(self):
        """Deleting the file must not silently stop recognising everyone."""
        writer = self.Gallery(self.path)
        writer.add("ramesh", self._vec(1))
        writer.save()
        reader = self.Gallery(self.path)

        os.remove(self.path)
        self.assertFalse(reader.reload_if_changed())
        self.assertEqual(reader.people, ["ramesh"])

    def test_a_corrupt_file_never_wipes_a_loaded_gallery(self):
        """A reader arriving mid-write keeps the gallery it already has."""
        writer = self.Gallery(self.path)
        writer.add("ramesh", self._vec(1))
        writer.save()
        reader = self.Gallery(self.path)

        with open(self.path, "wb") as f:
            f.write(b"half a file")
        self.assertFalse(reader.reload_if_changed())
        self.assertEqual(reader.people, ["ramesh"])

    def test_save_leaves_no_temporary_files_behind(self):
        """The rename target must be the real path, not path + '.npz.npz'."""
        g = self.Gallery(self.path)
        g.add("ramesh", self._vec(1))
        g.save()
        self.assertTrue(os.path.exists(self.path))
        leftovers = [f for f in os.listdir(self.dir) if ".tmp" in f]
        self.assertEqual(leftovers, [])

    def test_two_saves_in_the_same_second_are_still_detected(self):
        """mtime alone can miss a change inside one filesystem tick."""
        writer = self.Gallery(self.path)
        writer.add("a", self._vec(1))
        writer.save()
        reader = self.Gallery(self.path)

        writer.add("b", self._vec(2))
        writer.save()
        self.assertTrue(reader.reload_if_changed())
        self.assertEqual(reader.people, ["a", "b"])


class RenameAndConsent(unittest.TestCase):
    """Correcting a name, and the record a DPDP audit actually asks for."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "org.npz")
        from pipeline.gallery import Gallery
        self.Gallery = Gallery

    def _vec(self, seed):
        rng = np.random.default_rng(seed)
        v = rng.normal(size=512).astype(np.float32)
        return v / np.linalg.norm(v)

    def _seed(self, *names):
        g = self.Gallery(self.path)
        for i, n in enumerate(names):
            g.add(n, self._vec(i))
        g.save()
        return g

    def test_rename_keeps_the_embeddings(self):
        # The name is a label on a biometric record, not part of it: correcting
        # a typo must not change who the system recognises.
        self._seed("Ravi Shrama")
        before = self.Gallery(self.path).vectors.copy()
        out = run_bridge({"action": "rename", "name": "Ravi Shrama",
                          "newName": "Ravi Sharma"}, self.path)
        self.assertTrue(out["ok"])
        g = self.Gallery(self.path)
        self.assertEqual(g.people, ["Ravi Sharma"])
        np.testing.assert_array_equal(g.vectors, before)

    def test_rename_onto_an_existing_person_merges_them(self):
        # Two spellings of one person is the commonest way a gallery goes wrong.
        self._seed("Ravi Sharma", "Ravi S")
        out = run_bridge({"action": "rename", "name": "Ravi S",
                          "newName": "Ravi Sharma"}, self.path)
        self.assertTrue(out["ok"])
        self.assertTrue(out["mergedIntoExisting"])
        g = self.Gallery(self.path)
        self.assertEqual(g.people, ["Ravi Sharma"])
        self.assertEqual(len(g), 2)

    def test_renaming_somebody_who_is_not_enrolled_is_refused(self):
        self._seed("Ravi Sharma")
        out = run_bridge({"action": "rename", "name": "Nobody",
                          "newName": "Somebody"}, self.path)
        self.assertFalse(out["ok"])

    def test_a_rename_still_obeys_the_length_limit(self):
        self._seed("Ravi Sharma")
        out = run_bridge({"action": "rename", "name": "Ravi Sharma",
                          "newName": "x" * 200}, self.path)
        self.assertFalse(out["ok"])
        self.assertIn("truncated", out["error"])


class ConsentIsRecorded(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "org.npz")
        import enroll_api
        import pipeline.detect as detect_mod
        import pipeline.embed as embed_mod
        self.api, self.detect_mod, self.embed_mod = enroll_api, detect_mod, embed_mod
        self._d, self._e = detect_mod.FaceDetector, embed_mod.build_embedder
        self._dp, self._ep = config.DETECTOR_PATH, config.EMBEDDER_PATH
        config.DETECTOR_PATH = config.EMBEDDER_PATH = __file__

        class Face:
            bbox = (0, 0, 100, 100)
            aligned = np.zeros((112, 112, 3), np.uint8)
            eye_distance = 90.0

        class Detector:
            def __init__(self, *a, **k): pass
            def detect(self, frame): return [Face()]

        class Embedder:
            name = "stub"
            def embed(self, a):
                v = np.ones(512, np.float32)
                return v / np.linalg.norm(v)

        detect_mod.FaceDetector = Detector
        embed_mod.build_embedder = lambda *a, **k: Embedder()

    def tearDown(self):
        self.detect_mod.FaceDetector = self._d
        self.embed_mod.build_embedder = self._e
        config.DETECTOR_PATH, config.EMBEDDER_PATH = self._dp, self._ep

    def _gallery(self):
        from pipeline.gallery import Gallery
        return Gallery(self.path)

    def test_who_obtained_consent_and_when_is_stored(self):
        out = self.api.do_add(self._gallery(), {
            "name": "Ravi Sharma", "images": [jpeg_b64()],
            "consent": {"by": "acme-admin", "purpose": "Site access control"},
        })
        self.assertTrue(out["ok"])
        c = self._gallery().meta["Ravi Sharma"]["consent"]
        self.assertEqual(c["by"], "acme-admin")
        self.assertEqual(c["purpose"], "Site access control")
        # What matters is that it is an ABSOLUTE instant, not which spelling of
        # UTC it uses. "...Z" and "...+00:00" are both valid ISO-8601 and both
        # parse identically in Python and in the browser; asserting on the
        # letter Z would fail on a cosmetic change while a naive timestamp —
        # the thing that would actually break a consent record — slipped past.
        parsed = datetime.fromisoformat(c["at"])
        self.assertIsNotNone(parsed.tzinfo, "consent time must carry a timezone")
        self.assertEqual(parsed.utcoffset(), timedelta(0), "should be recorded in UTC")

    def test_a_later_top_up_does_not_restamp_the_original_consent(self):
        # The record must say when consent was FIRST obtained. Overwriting it
        # every time a photo is added would make the audit trail claim consent
        # was given on a date it was not.
        self.api.do_add(self._gallery(), {
            "name": "Ravi Sharma", "images": [jpeg_b64()],
            "consent": {"by": "acme-admin", "purpose": "Site access control"}})
        first = self._gallery().meta["Ravi Sharma"]["consent"]["at"]
        self.api.do_add(self._gallery(), {
            "name": "Ravi Sharma", "images": [jpeg_b64()],
            "consent": {"by": "someone-else", "purpose": "Changed my mind"}})
        c = self._gallery().meta["Ravi Sharma"]["consent"]
        self.assertEqual(c["at"], first)
        self.assertEqual(c["by"], "acme-admin")

    def test_list_reports_a_missing_consent_record_rather_than_hiding_it(self):
        # Somebody enrolled before consent was recorded must be visibly missing
        # it, not indistinguishable from a compliant entry.
        self.api.do_add(self._gallery(), {"name": "Old Entry", "images": [jpeg_b64()]})
        listed = self.api.do_list(self._gallery())
        entry = [p for p in listed["people"] if p["name"] == "Old Entry"][0]
        self.assertIsNone(entry["consent"])
