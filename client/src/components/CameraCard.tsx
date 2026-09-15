import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Video, Volume2, VolumeX, Camera, Maximize2 } from "lucide-react";
import { useWhepPlayer } from "@/hooks/useWhepPlayer";
import { fileStamp } from "@/lib/datetime";

export type CameraStatus = "online" | "offline" | "inactive";

export interface Camera {
  id: string;
  name: string;
  channelId: string;
  ipAddress?: string;
  status: CameraStatus;
  thumbnail?: string;
  streamUrl: string;
  streamType: string;
  videoCodec?: string;
}

interface CameraCardProps {
  camera: Camera;
  onView: (camera: Camera) => void;
  onAudioToggle: (camera: Camera) => void;
  onSnapshot: (camera: Camera) => void;
  onFullscreen: (camera: Camera) => void;
}

const statusConfig = {
  online: { color: "bg-status-online", text: "Streaming" },
  offline: { color: "bg-error", text: "Offline" },
  inactive: { color: "bg-status-offline", text: "Inactive" },
};

export default function CameraCard({
  camera,
  onView,
  onAudioToggle,
  onSnapshot,
  onFullscreen,
}: CameraCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [audioOn, setAudioOn] = useState(false);
  const { state: playerState } = useWhepPlayer(camera, videoRef);
  const isVideoLoaded = playerState === "playing";
  const hasError = playerState === "error";

  const status = statusConfig[camera.status];

  const handleAudioToggle = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = !audioOn;
    video.muted = !next;
    setAudioOn(next);
    onAudioToggle(camera);
  };

  // Captures the current live frame straight off the <video> element and
  // downloads it as a PNG — no server round-trip needed.
  const handleSnapshot = () => {
    const video = videoRef.current;
    if (!video || !isVideoLoaded || video.videoWidth === 0) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) return;
      // Site time, not UTC: this filename is what the operator sees in their
      // downloads folder and matches against an event list that is also in
      // site time.
      const ts = fileStamp(new Date());
      const safeName = camera.name.replace(/[^a-z0-9]/gi, "_");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${safeName}_${ts}.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");

    onSnapshot(camera);
  };

  return (
    <Card
      className="overflow-hidden hover-elevate active-elevate-2 cursor-pointer group"
      data-testid={`card-camera-${camera.id}`}
    >
      <div
        className="relative bg-black aspect-video flex items-center justify-center"
        onClick={() => {
          onView(camera);
        }}
      >
        {/* Live Video Preview - Only shows when status is "online" */}
        {camera.status === "online" && (
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            muted
            playsInline
            style={{ display: isVideoLoaded && !hasError ? "block" : "none" }}
          />
        )}

        {/* Fallback */}
        {(!isVideoLoaded || hasError || camera.status !== "online") && (
          <>
            {camera.thumbnail ? (
              <img
                src={camera.thumbnail}
                alt={camera.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <Camera className="h-16 w-16 text-muted-foreground opacity-30" />
            )}
          </>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
      </div>

      <div className="p-4 space-y-3">
        <div className="space-y-1">
          <h3
            className="font-semibold text-sm text-foreground"
            data-testid={`text-camera-name-${camera.id}`}
          >
            {camera.name}
          </h3>

          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              CH {camera.channelId}
            </Badge>
            <div className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${status.color}`} />
              <span className="text-xs text-muted-foreground">{status.text}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onView(camera);
            }}
            aria-label={`Open the live view for ${camera.name}`}
            title="Live view"
            data-testid={`button-view-${camera.id}`}
          >
            <Video className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            disabled={camera.status !== "online"}
            onClick={(e) => {
              e.stopPropagation();
              handleAudioToggle();
            }}
            aria-label={`${audioOn ? "Mute" : "Unmute"} audio for ${camera.name}`}
            title={audioOn ? "Mute audio" : "Unmute audio"}
            data-testid={`button-audio-${camera.id}`}
          >
            {audioOn ? (
              <Volume2 className="h-4 w-4" />
            ) : (
              <VolumeX className="h-4 w-4" />
            )}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            disabled={!isVideoLoaded}
            onClick={(e) => {
              e.stopPropagation();
              handleSnapshot();
            }}
            aria-label={`Save a still image from ${camera.name}`}
            title="Save a still image"
            data-testid={`button-snapshot-${camera.id}`}
          >
            <Camera className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onFullscreen(camera);
            }}
            aria-label={`Open ${camera.name} full screen`}
            title="Full screen"
            data-testid={`button-fullscreen-${camera.id}`}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}