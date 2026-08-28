"""Stage 3: the gallery — enrolled people, and the open-set decision.

THIS is where "unknown" is enforced, and why the system is not a classifier.

A softmax classifier over N employees always returns one of those N. A stranger
walks in and it confidently says "Ramesh". That failure is structural: the model
has no way to express "none of the above".

Here, recognition is a nearest-neighbour search in embedding space with an
ACCEPT THRESHOLD. If the closest enrolled person is not close enough, the answer
is "unknown". Nobody is ever assigned to the nearest person by default.

A second guard — the margin rule — rejects ambiguous matches where two different
people score almost identically (twins, siblings, or a bad crop). Being unsure
between two identities is not a reason to pick one.
"""
import json
import os

import numpy as np

UNKNOWN = "unknown"


class Gallery:
    def __init__(self, path):
        self.path = path
        self.names: list[str] = []      # per-embedding person name (repeats)
        self.vectors: np.ndarray = np.zeros((0, 512), dtype=np.float32)
        self.meta: dict = {}
        if os.path.exists(path):
            self.load()

    # ---------- persistence ----------
    def load(self) -> None:
        data = np.load(self.path, allow_pickle=False)
        self.vectors = data["vectors"].astype(np.float32)
        self.names = [str(n) for n in data["names"]]
        meta_path = self.path.replace(".npz", ".json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                self.meta = json.load(f)

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        np.savez(self.path, vectors=self.vectors,
                 names=np.array(self.names, dtype=object).astype("U128"))
        with open(self.path.replace(".npz", ".json"), "w") as f:
            json.dump(self.meta, f, indent=2)

    # ---------- enrolment ----------
    def add(self, name: str, vectors: np.ndarray, source: str = "") -> int:
        """Append embeddings for one person. Multiple images per person is the
        point: 3-5 covering slight pose/lighting variation makes the match far
        more robust than a single reference shot."""
        if vectors.ndim == 1:
            vectors = vectors[None, :]
        if self.vectors.size == 0:
            self.vectors = vectors.astype(np.float32)
        else:
            self.vectors = np.vstack([self.vectors, vectors.astype(np.float32)])
        self.names.extend([name] * len(vectors))
        m = self.meta.setdefault(name, {"images": 0, "sources": []})
        m["images"] += len(vectors)
        if source:
            m["sources"].append(source)
        return len(vectors)

    def remove(self, name: str) -> int:
        """Delete a person. No retraining — this is just dropping rows."""
        keep = [i for i, n in enumerate(self.names) if n != name]
        removed = len(self.names) - len(keep)
        self.vectors = self.vectors[keep] if keep else np.zeros((0, 512), np.float32)
        self.names = [self.names[i] for i in keep]
        self.meta.pop(name, None)
        return removed

    @property
    def people(self) -> list[str]:
        return sorted(set(self.names))

    def __len__(self) -> int:
        return len(self.names)

    # ---------- recognition ----------
    def match(self, embedding: np.ndarray, threshold: float,
              margin: float = 0.05) -> tuple[str, float, float]:
        """Return (name_or_unknown, best_similarity, runner_up_similarity).

        Both inputs are L2-normalised, so the dot product IS cosine similarity.
        Scores are per-PERSON (max over that person's images), not per-image, so
        somebody enrolled with 5 photos does not out-vote somebody with 3.
        """
        if len(self) == 0:
            return UNKNOWN, 0.0, 0.0

        sims = self.vectors @ embedding          # cosine, both normalised

        best_per_person: dict[str, float] = {}
        for name, s in zip(self.names, sims):
            if s > best_per_person.get(name, -1.0):
                best_per_person[name] = float(s)

        ranked = sorted(best_per_person.items(), key=lambda kv: kv[1], reverse=True)
        best_name, best_sim = ranked[0]
        runner_up = ranked[1][1] if len(ranked) > 1 else 0.0

        # Guard 1: not close enough to anyone -> unknown.
        if best_sim < threshold:
            return UNKNOWN, best_sim, runner_up
        # Guard 2: too close a call between two people -> refuse rather than guess.
        if len(ranked) > 1 and (best_sim - runner_up) < margin:
            return UNKNOWN, best_sim, runner_up
        return best_name, best_sim, runner_up
