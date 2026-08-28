import CameraCard, { Camera } from "./CameraCard";
import { Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, canWrite } from "@/lib/auth";

interface LiveViewProps {
  cameras: Camera[];
  onViewCamera: (camera: Camera) => void;
  onAudioToggle: (camera: Camera) => void;
  onSnapshot: (camera: Camera) => void;
  onFullscreen: (camera: Camera) => void;
  onAddCamera: () => void;
}

export default function LiveView({
  cameras,
  onViewCamera,
  onAudioToggle,
  onSnapshot,
  onFullscreen,
  onAddCamera,
}: LiveViewProps) {
  const auth = useAuth();
  const writable = canWrite(auth.role);

  if (cameras.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <Video className="h-16 w-16 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold text-foreground mb-2">No cameras added yet</h3>
        <p className="text-sm text-muted-foreground mb-6">
          {writable ? "Add your first camera to start monitoring" : "No cameras have been added to your organization yet"}
        </p>
        {writable && (
          <Button onClick={onAddCamera} data-testid="button-add-first-camera">
            Add Camera
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {cameras.map((camera) => (
        <CameraCard
          key={camera.id}
          camera={camera}
          onView={onViewCamera}
          onAudioToggle={onAudioToggle}
          onSnapshot={onSnapshot}
          onFullscreen={onFullscreen}
        />
      ))}
    </div>
  );
}
