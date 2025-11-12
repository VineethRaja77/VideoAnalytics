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
import { useQuery, useMutation } from "@tanstack/react-query";

type View = "login" | "live" | "add-camera" | "playback";

function Dashboard() {
  const [currentView, setCurrentView] = useState<View>("live");
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);
  const { toast } = useToast();

  // Fetch cameras from API
  const { data: cameras = [], refetch: refetchCameras } = useQuery<Camera[]>({
    queryKey: ["/api/cameras"],
  });

  const createCameraMutation = useMutation({
    mutationFn: async (cameraData: any) => {
      console.log("Creating camera with data:", cameraData);
      const response = await fetch("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cameraData),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error("Camera creation failed:", errorData);
        throw new Error(errorData.error || "Failed to create camera");
      }
      
      return response.json();
    },
    onSuccess: (data) => {
      console.log("Camera created successfully:", data);
      refetchCameras();
      setCurrentView("live");
      toast({
        title: "Camera Added",
        description: `${data.name} has been added successfully`,
      });
    },
    onError: (error: any) => {
      console.error("Camera creation error:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to add camera",
        variant: "destructive",
      });
    },
  });

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
    createCameraMutation.mutate(cameraData);
  };

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  const viewPath = currentView === "live" ? "/live" : currentView === "add-camera" ? "/add-camera" : "/playback";

  return (
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
  );
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const { toast } = useToast();

  const loginMutation = useMutation({
    mutationFn: async ({ username, password }: { username: string; password: string }) => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      
      if (!response.ok) {
        throw new Error("Invalid credentials");
      }
      
      return response.json();
    },
    onSuccess: () => {
      setIsAuthenticated(true);
      toast({
        title: "Welcome to Hyperspark",
        description: "Successfully logged in",
      });
    },
    onError: () => {
      toast({
        title: "Login Failed",
        description: "Invalid username or password",
        variant: "destructive",
      });
    },
  });

  const handleLogin = (username: string, password: string, remember: boolean) => {
    loginMutation.mutate({ username, password });
  };

  if (!isAuthenticated) {
    return (
      <LoginPage onLogin={handleLogin} />
    );
  }

  return <Dashboard />;
}

function AppWrapper() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default AppWrapper;
