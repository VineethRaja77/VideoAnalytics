import PlaybackView from "../PlaybackView";
import { Camera } from "../CameraCard";

const mockCameras: Camera[] = [
  { id: "1", name: "CP IP Cam", channelId: "4", status: "online" },
  { id: "2", name: "CP IP Cam", channelId: "5", status: "online" },
  { id: "3", name: "Channel6", channelId: "6", status: "offline" },
];

export default function PlaybackViewExample() {
  return (
    <div className="p-6 bg-background min-h-screen">
      <PlaybackView cameras={mockCameras} />
    </div>
  );
}
