import { useEffect, useRef, useState, type RefObject } from "react";
import { apiRequest } from "@/lib/queryClient";
import { startWhepPlayback, type WhepPlayerState } from "@/lib/webrtc";
import { browserSupportsH265Webrtc } from "@/lib/codecCapability";
import type { Camera } from "@/components/CameraCard";

const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000];
const VIDEO_MOUNT_POLL_MS = 50;
const VIDEO_MOUNT_MAX_ATTEMPTS = 40; // 2s total — generous for a Radix Dialog portal to mount

interface WebrtcConfigResponse {
  whepUrl: string;
}

/**
 * Shared live-view player hook: resolves the correct WHEP path for a camera
 * (native passthrough, or the on-demand H.265->H.264 transcode path when
 * this browser can't decode H.265 over WebRTC) and manages the
 * RTCPeerConnection lifecycle with capped-backoff retry/reconnect — the one
 * thing the old per-component hls.js integrations both lacked.
 */
export function useWhepPlayer(camera: Pick<Camera, "id" | "status" | "videoCodec">, videoRef: RefObject<HTMLVideoElement>) {
  const [state, setState] = useState<WhepPlayerState>("closed");
  const retryCountRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    function cleanup() {
      if (timerRef.current) clearTimeout(timerRef.current);
      stopRef.current?.();
      stopRef.current = null;
    }

    async function connect(mountAttempt = 0) {
      if (cancelled || camera.status !== "online") return;
      const video = videoRef.current;
      if (!video) {
        // The <video> element may not be mounted into the DOM yet — e.g. a
        // Radix Dialog's portal content mounts a tick after `open` flips
        // true. Poll briefly rather than silently giving up.
        if (mountAttempt >= VIDEO_MOUNT_MAX_ATTEMPTS) {
          console.error("useWhepPlayer: video element never mounted, giving up");
          return;
        }
        timerRef.current = setTimeout(() => connect(mountAttempt + 1), VIDEO_MOUNT_POLL_MS);
        return;
      }

      try {
        const needsTranscode = camera.videoCodec === "h265" && !browserSupportsH265Webrtc();
        const res = await apiRequest(
          "GET",
          `/api/webrtc-config/${camera.id}${needsTranscode ? "?needsTranscode=true" : ""}`
        );
        const config: WebrtcConfigResponse = await res.json();
        if (cancelled) return;

        stopRef.current = startWhepPlayback({
          whepUrl: config.whepUrl,
          videoEl: video,
          onStateChange: (s) => {
            if (cancelled) return;
            setState(s);
            if (s === "playing") {
              retryCountRef.current = 0;
              video.play().catch(() => {});
            }
            if (s === "error") scheduleRetry();
          },
        });
      } catch (err) {
        console.error("Failed to resolve WHEP config:", err);
        if (!cancelled) scheduleRetry();
      }
    }

    function scheduleRetry() {
      if (cancelled) return;
      const delay = RETRY_DELAYS_MS[Math.min(retryCountRef.current, RETRY_DELAYS_MS.length - 1)];
      retryCountRef.current += 1;
      timerRef.current = setTimeout(() => {
        cleanup();
        connect();
      }, delay);
    }

    if (camera.status === "online") {
      connect();
    } else {
      setState("closed");
    }

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, camera.status, camera.videoCodec]);

  return { state };
}
