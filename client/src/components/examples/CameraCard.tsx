import CameraCard, { Camera } from "../CameraCard";

const mockCamera: Camera = {
  id: "1",
  name: "CP IP Cam",
  channelId: "4",
  status: "online",
};

export default function CameraCardExample() {
  return (
    <div className="p-6 bg-background">
      <div className="max-w-xs">
        <CameraCard
          camera={mockCamera}
          onView={(cam) => console.log("View camera:", cam.name)}
          onAudioToggle={(cam) => console.log("Audio toggle:", cam.name)}
          onSnapshot={(cam) => console.log("Snapshot:", cam.name)}
          onFullscreen={(cam) => console.log("Fullscreen:", cam.name)}
        />
      </div>
    </div>
  );
}
