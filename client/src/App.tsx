import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import LoginPage from "@/components/LoginPage";
import AppSidebar from "@/components/AppSidebar";
import TopHeader from "@/components/TopHeader";
import LiveView from "@/components/LiveView";
import AddCameraForm from "@/components/AddCameraForm";
import PlaybackView from "@/components/PlaybackView";
import LivePlayerModal from "@/components/LivePlayerModal";
import { Camera } from "@/components/CameraCard";
import { useToast } from "@/hooks/use-toast";

type View = "login" | "live" | "add-camera" | "playback";

function App() {
  const [currentView, setCurrentView] = useState<View>("login");
  const [cameras, setCameras] = useState<Camera[]>([
    { id: "1", name: "CP IP Cam", channelId: "4", status: "online" },
    { id: "2", name: "CP IP Cam", channelId: "5", status: "online" },
    { id: "3", name: "CP IP Cam", channelId: "6", status: "offline" },
    { id: "4", name: "Channel4", channelId: "7", status: "inactive" },
    { id: "5", name: "Channel5", channelId: "8", status: "online" },
    { id: "6", name: "Channel6", channelId: "9", status: "inactive" },
  ]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);
  const { toast } = useToast();

  const handleLogin = (username: string, password: string, remember: boolean) => {
    console.log("Login:", { username, password, remember });
    setCurrentView("live");
    toast({
      title: "Welcome to Hyperspark",
      description: "Successfully logged in",
    });
  };

  const handleNavigate = (path: string) => {
    const viewMap: Record<string, View> = {
      "/live": "live",
      "/add-camera": "add-camera",
      "/playback": "playback",
    };
    setCurrentView(viewMap[path] || "live");
  };

  const handleViewCamera = (camera: Camera) => {
    setSelectedCamera(camera);
    setIsPlayerOpen(true);
  };

  const handleAudioToggle = (camera: Camera) => {
    console.log("Audio toggle:", camera.name);
    toast({
      title: "Audio",
      description: `Audio toggled for ${camera.name}`,
    });
  };

  const handleSnapshot = (camera: Camera) => {
    console.log("Snapshot:", camera.name);
    toast({
      title: "Snapshot Captured",
      description: `Snapshot saved for ${camera.name}`,
    });
  };

  const handleFullscreen = (camera: Camera) => {
    console.log("Fullscreen:", camera.name);
    handleViewCamera(camera);
  };

  const handleSaveCamera = (cameraData: any) => {
    const newCamera: Camera = {
      id: String(cameras.length + 1),
      name: cameraData.cameraName,
      channelId: cameraData.channelId,
      status: "online",
    };
    setCameras([...cameras, newCamera]);
    setCurrentView("live");
    toast({
      title: "Camera Added",
      description: `${cameraData.cameraName} has been added successfully`,
    });
  };

  if (currentView === "login") {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <LoginPage onLogin={handleLogin} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  const viewPath = currentView === "live" ? "/live" : currentView === "add-camera" ? "/add-camera" : "/playback";

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider style={style as React.CSSProperties}>
          <div className="flex h-screen w-full overflow-hidden">
            <AppSidebar currentPath={viewPath} onNavigate={handleNavigate} />
            <div className="flex flex-col flex-1 overflow-hidden">
              <TopHeader notificationCount={3} />
              <main className="flex-1 overflow-auto p-6">
                {currentView === "live" && (
                  <LiveView
                    cameras={cameras}
                    onViewCamera={handleViewCamera}
                    onAudioToggle={handleAudioToggle}
                    onSnapshot={handleSnapshot}
                    onFullscreen={handleFullscreen}
                    onAddCamera={() => setCurrentView("add-camera")}
                  />
                )}
                {currentView === "add-camera" && (
                  <AddCameraForm
                    onSave={handleSaveCamera}
                    onCancel={() => setCurrentView("live")}
                  />
                )}
                {currentView === "playback" && <PlaybackView cameras={cameras} />}
              </main>
            </div>
          </div>
          <LivePlayerModal
            camera={selectedCamera}
            isOpen={isPlayerOpen}
            onClose={() => setIsPlayerOpen(false)}
          />
        </SidebarProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
