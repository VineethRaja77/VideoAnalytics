import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Camera, Volume2, VolumeX, Maximize2, X } from "lucide-react";
import { Camera as CameraType } from "./CameraCard";

interface LivePlayerModalProps {
  camera: CameraType | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function LivePlayerModal({ camera, isOpen, onClose }: LivePlayerModalProps) {
  if (!camera) return null;

  const statusColor = {
    online: "bg-status-online",
    offline: "bg-error",
    inactive: "bg-status-offline",
  }[camera.status];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl p-0" data-testid="modal-live-player">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span>{camera.name}</span>
              <Badge variant="secondary">CH {camera.channelId}</Badge>
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${statusColor}`} />
                <span className="text-xs text-muted-foreground font-normal capitalize">
                  {camera.status}
                </span>
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="p-6 pt-4 space-y-4">
          <div className="relative bg-black aspect-video rounded-md flex items-center justify-center">
            <Camera className="h-24 w-24 text-muted-foreground opacity-20" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="text-sm">
                <span className="text-muted-foreground">Resolution:</span>
                <span className="ml-2 text-foreground">1920x1080</span>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">FPS:</span>
                <span className="ml-2 text-foreground">30</span>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Last Active:</span>
                <span className="ml-2 text-foreground">2 minutes ago</span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">Stream Quality</label>
                <Select defaultValue="auto">
                  <SelectTrigger data-testid="select-quality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" data-testid="button-modal-audio">
              <Volume2 className="h-4 w-4 mr-2" />
              Audio
            </Button>
            <Button variant="secondary" data-testid="button-modal-fullscreen">
              <Maximize2 className="h-4 w-4 mr-2" />
              Fullscreen
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
