import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Video, Volume2, VolumeX, Camera, Maximize2 } from "lucide-react";

export type CameraStatus = "online" | "offline" | "inactive";

export interface Camera {
  id: string;
  name: string;
  channelId: string;
  status: CameraStatus;
  thumbnail?: string;
}

interface CameraCardProps {
  camera: Camera;
  onView: (camera: Camera) => void;
  onAudioToggle: (camera: Camera) => void;
  onSnapshot: (camera: Camera) => void;
  onFullscreen: (camera: Camera) => void;
}

const statusConfig = {
  online: { color: "bg-status-online", text: "Online" },
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
  const status = statusConfig[camera.status];

  return (
    <Card className="overflow-hidden hover-elevate active-elevate-2 cursor-pointer group" data-testid={`card-camera-${camera.id}`}>
      <div
        className="relative bg-black aspect-video flex items-center justify-center"
        onClick={() => onView(camera)}
      >
        {camera.thumbnail ? (
          <img src={camera.thumbnail} alt={camera.name} className="w-full h-full object-cover" />
        ) : (
          <Camera className="h-16 w-16 text-muted-foreground opacity-30" />
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
      </div>

      <div className="p-4 space-y-3">
        <div className="space-y-1">
          <h3 className="font-semibold text-sm text-foreground" data-testid={`text-camera-name-${camera.id}`}>
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
            data-testid={`button-view-${camera.id}`}
          >
            <Video className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onAudioToggle(camera);
            }}
            data-testid={`button-audio-${camera.id}`}
          >
            {camera.status === "online" ? (
              <Volume2 className="h-4 w-4" />
            ) : (
              <VolumeX className="h-4 w-4" />
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onSnapshot(camera);
            }}
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
            data-testid={`button-fullscreen-${camera.id}`}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
