"""Stage 2: face embedding.

Turns an aligned 112x112 crop into a 512-d vector. NOTHING IS TRAINED HERE — the
embedder is frozen. Adding or removing a person changes the gallery, never the
model. That is what makes "unknown" possible: there is no fixed set of output
classes for a stranger to be forced into.

Backend is swappable on purpose. The AuraFace weights are Apache-2.0 per fal's
model card, but three separate provenance requests on the HF discussion have gone
unanswered since Sept 2025. Keeping dlib (public domain, unambiguous) selectable
means a licence problem is a config change, not a rewrite.
"""
import numpy as np
import onnxruntime as ort


class ArcFaceEmbedder:
    """ONNX ArcFace-family embedder (AuraFace glintr100, or any 112x112 -> 512)."""

    name = "auraface"
    dim = 512

    def __init__(self, model_path, providers=None):
        self.session = ort.InferenceSession(
            model_path, providers=providers or ["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name

    @staticmethod
    def _preprocess(aligned_bgr) -> np.ndarray:
        """BGR uint8 112x112 -> NCHW float32 normalised to [-1, 1].

        ArcFace convention is (pixel - 127.5) / 127.5 on RGB. Getting this wrong
        silently degrades similarity rather than erroring, so it is worth being
        explicit.
        """
        img = aligned_bgr[:, :, ::-1]                      # BGR -> RGB
        img = img.astype(np.float32)
        img = (img - 127.5) / 127.5
        img = np.transpose(img, (2, 0, 1))                 # HWC -> CHW
        return np.expand_dims(img, 0)                      # -> NCHW

    def embed(self, aligned_bgr) -> np.ndarray:
        """Return an L2-normalised 512-d embedding."""
        blob = self._preprocess(aligned_bgr)
        vec = self.session.run([self.output_name], {self.input_name: blob})[0][0]
        norm = np.linalg.norm(vec)
        # L2-normalise so cosine similarity is a plain dot product. ArcFace
        # embeddings live on a hypersphere; unnormalised vectors make the
        # threshold meaningless.
        return vec / norm if norm > 0 else vec

    def embed_batch(self, aligned_list) -> np.ndarray:
        if not aligned_list:
            return np.zeros((0, self.dim), dtype=np.float32)
        blob = np.concatenate([self._preprocess(a) for a in aligned_list], axis=0)
        vecs = self.session.run([self.output_name], {self.input_name: blob})[0]
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return vecs / norms


def build_embedder(backend: str, model_path: str):
    if backend in ("auraface", "arcface", "onnx"):
        return ArcFaceEmbedder(model_path)
    if backend == "dlib":
        raise NotImplementedError(
            "dlib backend not wired yet — install dlib and the public-domain "
            "dlib_face_recognition_resnet_model_v1.dat, then implement a "
            "DlibEmbedder with the same .embed()/.dim interface. Note dlib's "
            "68-point landmark model is NOT free for commercial use; use the "
            "5-point one."
        )
    raise ValueError(f"unknown FACE_BACKEND: {backend}")
