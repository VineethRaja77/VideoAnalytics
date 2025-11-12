import { useState } from "react";
import LivePlayerModal from "../LivePlayerModal";
import { Button } from "@/components/ui/button";
import { Camera } from "../CameraCard";

const mockCamera: Camera = {
  id: "1",
  name: "CP IP Cam",
  channelId: "4",
  status: "online",
};

export default function LivePlayerModalExample() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="p-6 bg-background min-h-screen">
      <Button onClick={() => setIsOpen(true)}>Open Live Player</Button>
      <LivePlayerModal camera={mockCamera} isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </div>
  );
}
