// WHEP (WebRTC-HTTP Egress Protocol) client for pulling live video from
// MediaMTX. One RTCPeerConnection per player; the WHEP handshake is a single
// POST of our SDP offer, answered with MediaMTX's SDP answer.
export type WhepPlayerState = "connecting" | "playing" | "error" | "closed";

export interface WhepPlayerOptions {
  whepUrl: string;
  videoEl: HTMLVideoElement;
  onStateChange?: (state: WhepPlayerState) => void;
}

export function startWhepPlayback(opts: WhepPlayerOptions): () => void {
  const pc = new RTCPeerConnection({ iceServers: [] });
  let closed = false;

  pc.ontrack = (evt) => {
    if (opts.videoEl.srcObject !== evt.streams[0]) {
      opts.videoEl.srcObject = evt.streams[0];
    }
  };

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  (async () => {
    try {
      opts.onStateChange?.("connecting");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch(opts.whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });

      if (!res.ok) throw new Error(`WHEP request failed: ${res.status}`);
      if (closed) return;

      const answerSdp = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      if (!closed) opts.onStateChange?.("playing");
    } catch (err) {
      if (!closed) {
        console.error("WHEP playback error:", err);
        opts.onStateChange?.("error");
      }
    }
  })();

  return () => {
    closed = true;
    pc.close();
  };
}
