"""Decides WHEN a face is worth telling the operator about.

Detection and recognition answer "who is this". This answers the separate and
equally important question "have I already said so" — and getting it wrong is
what makes people switch a security feature off.

THREE THINGS GO WRONG WITHOUT THIS, ALL OBSERVED ON A REAL CLIP

  1. One appearance, many alerts. A person standing in view is recognised on
     every sampled frame. Guarded by a per-TRACK cooldown.

  2. One person, many alerts. A track id is not a person: it resets on an
     occlusion, on somebody turning away and back, and on every stream
     reconnect — which a site network does regularly. On a 45-second clip with
     five reconnects, one person produced three alerts. Guarded by a per-PERSON
     cooldown that outlives the track.

  3. A stranger silently swallowed. Faces are associated across frames by box
     overlap with no appearance check, so at a gate — where people occupy the
     same spot one after another — the newcomer inherits the departing person's
     track id. The per-track cooldown then suppresses their alert entirely, and
     the identity vote mixes two people together. A stranger walks in and
     NOBODY IS TOLD. Guarded by comparing each observation against what that
     track looked like a moment ago.

WHY "UNKNOWN" IS NOT DEDUPLICATED BY NAME
  Every stranger is called "unknown", so suppressing repeats by that label
  would hide the second stranger of the minute. Repeats among unknowns are
  judged on the FACE instead: an embedding close to one already reported is the
  same person coming back; anything else is somebody new and is reported.
"""
from __future__ import annotations

UNKNOWN = "unknown"


class AlertGate:
    def __init__(self, cooldown_s: float, unknown_same_person_sim: float,
                 track_identity_sim: float):
        self.cooldown_s = cooldown_s
        self.unknown_same_person_sim = unknown_same_person_sim
        self.track_identity_sim = track_identity_sim
        # Absent key = never announced. Deliberately not "0", which would mean
        # "announced at the epoch" and is indistinguishable from a real
        # timestamp on any clock that starts at zero.
        self.by_track: dict[int, float] = {}      # track id -> last alert time
        self.by_person: dict[str, float] = {}     # name     -> last alert time
        self.recent_unknown: list[tuple] = []     # [(embedding, time)]
        self.track_face: dict[int, object] = {}   # track id -> last embedding
        self.said: dict[int, str] = {}            # track id -> who we last named

    # ------------------------------------------------------------------ #
    def track_changed(self, tid: int, embedding) -> bool:
        """Is this a DIFFERENT person on an existing track id?

        Called for every observation, and it also records the embedding, so the
        comparison is always against the immediately preceding sighting on that
        track rather than a stale one.
        """
        prev = self.track_face.get(tid)
        self.track_face[tid] = embedding
        if prev is None:
            return False
        return float(prev @ embedding) < self.track_identity_sim

    def should_announce(self, tid: int, person: str, embedding, now: float) -> bool:
        """Emit an event for this observation? Records the decision when True."""
        # A CHANGE of identity on a track is news, not a repeat.
        #
        # An identity is announced as soon as a few frames agree, and only
        # becomes settled a second or two later. Suppressing everything after
        # the first event therefore froze the operator's view at the earliest,
        # least certain answer: a face first called "unknown" and then resolved
        # to a named employee was never corrected on screen, and every event
        # read "still settling" forever because the settled one was swallowed.
        # A changed answer is allowed through; a repeated one is not.
        changed = self.said.get(tid) not in (None, person)
        if not changed and self._cooling(self.by_track.get(tid), now):
            return False

        if person != UNKNOWN:
            if self._cooling(self.by_person.get(person), now):
                # Mark the track as handled anyway: without this the same track
                # is re-tested on every frame for the whole cooldown.
                self.by_track[tid] = now
                self.said[tid] = person
                return False
            self.by_track[tid] = now
            self.by_person[person] = now
            self.said[tid] = person
            return True

        self._expire_unknown(now)
        if any(float(v @ embedding) >= self.unknown_same_person_sim
               for v, _ in self.recent_unknown):
            self.by_track[tid] = now
            self.said[tid] = person
            return False

        self.by_track[tid] = now
        self.said[tid] = person
        self.recent_unknown.append((embedding, now))
        return True

    def reset_track(self, tid: int) -> None:
        """Forget a track's history — used when it changes person."""
        self.by_track.pop(tid, None)
        self.said.pop(tid, None)

    def forget_absent(self, live_ids, now: float) -> None:
        """Drop state for retired tracks.

        A 24/7 worker issues track ids without bound, so every dict here grows
        forever unless it is pruned. The person and unknown records are bounded
        by the cooldown instead of by track lifetime.
        """
        for tid in [t for t in self.by_track if t not in live_ids]:
            self.by_track.pop(tid, None)
        for tid in [t for t in self.track_face if t not in live_ids]:
            self.track_face.pop(tid, None)
        for tid in [t for t in self.said if t not in live_ids]:
            self.said.pop(tid, None)
        cutoff = now - self.cooldown_s
        for p in [p for p, t in self.by_person.items() if t < cutoff]:
            self.by_person.pop(p, None)
        self._expire_unknown(now)

    def _cooling(self, last: float | None, now: float) -> bool:
        """Still inside the cooldown? Never-announced is never cooling."""
        return last is not None and (now - last) < self.cooldown_s

    def _expire_unknown(self, now: float) -> None:
        cutoff = now - self.cooldown_s
        self.recent_unknown[:] = [(v, t) for v, t in self.recent_unknown if t >= cutoff]
