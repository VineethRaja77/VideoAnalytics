import LiveView from "../LiveView";
import { Camera } from "../CameraCard";

const mockCameras: Camera[] = [
  { id: "1", name: "CP IP Cam", channelId: "4", status: "online" },
  { id: "2", name: "CP IP Cam", channelId: "5", status: "online" },
  { id: "3", name: "CP IP Cam", channelId: "6", status: "offline" },
  { id: "4", name: "Channel4", channelId: "7", status: "inactive" },
];

export default function LiveViewExample() {
  return (
    <div className="p-6 bg-background min-h-screen">
      <LiveView
        cameras={mockCameras}
        onViewCamera={(cam) => console.log("View:", cam.name)}
        onAudioToggle={(cam) => console.log("Audio:", cam.name)}
        onSnapshot={(cam) => console.log("Snapshot:", cam.name)}
        onFullscreen={(cam) => console.log("Fullscreen:", cam.name)}
        onAddCamera={() => console.log("Add camera clicked")}
      />
    </div>
  );
}
