import { useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Camera as CameraType } from "./CameraCard";
import { useWhepPlayer } from "@/hooks/useWhepPlayer";

interface LivePlayerModalProps {
  camera: CameraType | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function LivePlayerModal({
  camera,
  isOpen,
  onClose,
}: LivePlayerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useWhepPlayer(
    {
      id: camera?.id ?? "",
      status: isOpen && camera ? camera.status : "inactive",
      videoCodec: camera?.videoCodec,
    },
    videoRef
  );

  if (!camera) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl p-0">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle className="flex items-center gap-3">
            {camera.name}
            <Badge variant="secondary">CH {camera.channelId}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="p-6 pt-4">
          <div className="relative bg-black aspect-video rounded-md">
            <video
              ref={videoRef}
              className="w-full h-full object-cover rounded-md"
              controls
              autoPlay
              muted
              playsInline
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
