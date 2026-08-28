// One-time, client-side, zero-network-cost check of whether this browser's
// WebRTC stack can decode H.265 — never trial-and-error. Firefox and Edge
// don't implement it at all; Chrome only on Windows with a capable GPU;
// Safari 18+ supports it. Used to decide, before ever opening a connection,
// whether a camera's native H.265 WebRTC path will work for this viewer.
let cachedFile: boolean | null = null;

/**
 * Whether this browser can decode H.265/HEVC inside an MP4 played through a
 * <video> element (recordings playback/export preview). Chrome only supports
 * this when the machine has a hardware HEVC decoder; Firefox not at all.
 * Distinct from the WebRTC check below — the two decode paths differ.
 */
export function browserSupportsH265File(): boolean {
  if (cachedFile !== null) return cachedFile;
  const probe = document.createElement("video");
  cachedFile =
    probe.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"') !== "" ||
    probe.canPlayType('video/mp4; codecs="hev1.1.6.L153.B0"') !== "";
  return cachedFile;
}

let cached: boolean | null = null;

export function browserSupportsH265Webrtc(): boolean {
  if (cached !== null) return cached;

  if (typeof RTCRtpReceiver === "undefined" || !RTCRtpReceiver.getCapabilities) {
    cached = false;
    return cached;
  }

  const caps = RTCRtpReceiver.getCapabilities("video");
  cached = !!caps?.codecs.some((c) => /^video\/H265$/i.test(c.mimeType));
  return cached;
}
