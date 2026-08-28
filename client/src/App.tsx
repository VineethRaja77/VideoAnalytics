import { useState, useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, apiRequest } from "./lib/queryClient";
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

import CameraList from "@/components/cameralist";
import SuperAdminConsole from "@/components/SuperAdminConsole";
import AuditLogView from "@/components/AuditLogView";
import OrgUsers from "@/components/OrgUsers";
import AlertsView from "@/components/AlertsView";
import VehicleEventsView from "@/components/VehicleEventsView";
import FaceEventsView from "@/components/FaceEventsView";
import { Camera } from "@/components/CameraCard";
import { AuthContext, isSameSession, type AuthUser } from "@/lib/auth";

import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";

type View = "login" | "live" | "add-camera" | "camera-list" | "logout" | "playback" | "users" | "alerts" | "vehicles" | "faces" | "audit";

function Dashboard({ onLogout, username }: { onLogout: () => void; username: string }) {
  console.log("🟦 Dashboard Rendered");

  const [currentView, setCurrentView] = useState<View>("live");
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");

  const { toast } = useToast();

  const { data: cameras = [], refetch: refetchCameras } = useQuery<Camera[]>({
    queryKey: ["/api/cameras"],
    refetchInterval: 10_000,
  });

  useEffect(() => {
    console.log("📡 Cameras Loaded:", cameras);
  }, [cameras]);

  const createCameraMutation = useMutation({
    mutationFn: async (cameraData: any) => {
      const response = await apiRequest("POST", "/api/cameras", cameraData);
      return response.json();
    },
    onSuccess: (data) => {
      console.log("📷 Camera Created:", data);

      refetchCameras();
      setCurrentView("live");

      toast({
        title: "📷 Camera Added",
        description: `${data.name} added successfully`,
      });
    },
    onError: (error: any) => {
      console.error("❌ Camera Create FAILED:", error);

      toast({
        title: "⚠️ Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleNavigate = (path: string) => {
    console.log("🔀 Navigation Clicked →", path);

    if (path === "/logout") {
      console.log("🚪 Logging out...");
      onLogout();
      return;
    }

    const viewMap: Record<string, View> = {
      "/live": "live",
      "/add-camera": "add-camera",
      "/playback": "playback",
      "/cameralist": "camera-list",
      "/alerts": "alerts",
      "/vehicles": "vehicles",
      "/faces": "faces",
      "/users": "users",
      "/audit": "audit",
      "/logout": "logout",
    };

    setCurrentView(viewMap[path] || "live");
  };

  const handleViewCamera = (camera: Camera) => {
    console.log("🎬 handleViewCamera CALLED:", camera);

    setSelectedCamera(camera);
    setIsPlayerOpen(true);
  };

  useEffect(() => {
    console.log("🎯 selectedCamera UPDATED:", selectedCamera);
  }, [selectedCamera]);

  useEffect(() => {
    console.log("📺 isPlayerOpen:", isPlayerOpen);
  }, [isPlayerOpen]);

  const handleAudioToggle = (camera: Camera) => {
    console.log("🔊 Audio Toggle:", camera);
    toast({ title: "Audio toggled" });
  };

  const handleSnapshot = (camera: Camera) => {
    console.log("📸 Snapshot Clicked:", camera);
    toast({ title: "Snapshot saved" });
  };

  const handleFullscreen = (camera: Camera) => {
    console.log("🖥️ Fullscreen Clicked:", camera);
    handleViewCamera(camera);
  };

  const handleSaveCamera = (cameraData: any) => {
    console.log("💾 Saving camera:", cameraData);
    createCameraMutation.mutate(cameraData);
  };

  const filteredCameras = cameras.filter((cam) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return cam.name.toLowerCase().includes(q) || cam.channelId.includes(q);
  });

  return (
    <SidebarProvider>
      <div className="flex h-screen w-full overflow-hidden">
        <AppSidebar currentPath="/" onNavigate={handleNavigate} />

        <div className="flex flex-col flex-1 overflow-hidden">
          <TopHeader
            onSearch={(q) => {
              console.log("🔍 Search Query:", q);
              setSearchQuery(q);
            }}
            username={username}
            onLogout={onLogout}
          />

          <main className="flex-1 overflow-auto p-6">
            {currentView === "live" && (
              <LiveView
                cameras={filteredCameras}
                onViewCamera={handleViewCamera}
                onAudioToggle={handleAudioToggle}
                onSnapshot={handleSnapshot}
                onFullscreen={handleFullscreen}
                onAddCamera={() => {
                  console.log("➕ Add Camera Clicked");
                  setCurrentView("add-camera");
                }}
              />
            )}

            {currentView === "add-camera" && (
              <AddCameraForm
                onSave={handleSaveCamera}
                onCancel={() => {
                  console.log("❌ Cancel Add Camera");
                  setCurrentView("live");
                }}
              />
            )}

            {currentView === "camera-list" && (
              <CameraList
                cameras={filteredCameras}
                onAddCamera={() => {
                  console.log("📋 Go to Add Camera");
                  setCurrentView("add-camera");
                }}

                // ✅ FULLY WORKING UPDATE CAMERA
                onUpdateCamera={async (cam) => {
                  try {
                    await apiRequest("PATCH", `/api/cameras/${cam.id}`, cam);
                    toast({ title: "Camera updated successfully" });
                    await refetchCameras();
                  } catch (err) {
                    console.error("Update error:", err);
                    toast({
                      title: "Update failed",
                      variant: "destructive",
                    });
                  }
                }}

                // ✅ FULLY WORKING DELETE CAMERA
                onDeleteCamera={async (id) => {
                  try {
                    await apiRequest("DELETE", `/api/cameras/${id}`);
                    toast({ title: "Camera deleted successfully" });
                    await refetchCameras();
                  } catch (err) {
                    console.error("Delete error:", err);
                    toast({
                      title: "Delete failed",
                      variant: "destructive",
                    });
                  }
                }}
              />
            )}

            {currentView === "playback" && (
              <PlaybackView cameras={filteredCameras} />
            )}

            {currentView === "alerts" && <AlertsView cameras={cameras} />}
            {currentView === "vehicles" && <VehicleEventsView cameras={cameras} />}
            {currentView === "faces" && <FaceEventsView cameras={cameras} />}

            {currentView === "users" && <OrgUsers />}
            {currentView === "audit" && <AuditLogView />}
          </main>
        </div>
      </div>

      <LivePlayerModal
        camera={selectedCamera}
        isOpen={isPlayerOpen}
        onClose={() => {
          console.log("❌ Closing Player");
          setIsPlayerOpen(false);
        }}
      />
    </SidebarProvider>
  );
}

// -------------------- AUTH ------------------------
function App() {
  // The full authenticated user (role/org/modules), or null when logged out.
  // `undefined` = still checking the session on load.
  const [me, setMe] = useState<AuthUser | null | undefined>(undefined);
  // Set when ANOTHER tab signs in as someone else. This tab is then locked
  // rather than left rendering the previous user's screen under a new session.
  const [sessionTakenOver, setSessionTakenOver] = useState<string | null>(null);
  const { toast } = useToast();

  const loadMe = async (): Promise<AuthUser | null> => {
    try {
      const res = await apiRequest("GET", "/api/auth/me");
      const user = (await res.json()) as AuthUser;
      setMe(user);
      return user;
    } catch {
      setMe(null);
      return null;
    }
  };

  useEffect(() => {
    // Session restore on refresh — don't bounce a valid session to sign-in.
    void loadMe();
  }, []);

  /**
   * Cross-tab identity watch.
   *
   * The session cookie belongs to the browser profile, not the tab. If a client
   * admin has this tab open and an employee signs in on another tab of the same
   * browser, THIS tab is now authenticated as the employee — while still
   * displaying admin data from the React Query cache. On a shared control-room
   * PC that is a privilege and data mix-up.
   *
   * Polling every 15s (rather than a websocket) keeps this independent of the
   * live-stream plumbing: it must keep working even when everything else is
   * broken. `document.hidden` is ignored deliberately — a background tab is
   * exactly the one likely to be stale.
   */
  useEffect(() => {
    if (!me) return;
    const id = setInterval(async () => {
      let current: AuthUser | null = null;
      try {
        const res = await apiRequest("GET", "/api/auth/me");
        current = (await res.json()) as AuthUser;
      } catch {
        current = null; // 401: signed out elsewhere, or the session expired
      }

      if (isSameSession(me, current)) return;

      // Identity changed under this tab. Drop every cached response before
      // rendering anything else — the cache holds the previous user's cameras,
      // events and user list, and staleTime is Infinity so it would be served
      // without a refetch.
      queryClient.clear();
      setSessionTakenOver(
        current
          ? `You were signed in as ${current.username} in another tab.`
          : "Your session ended in another tab."
      );
      setMe(null);
    }, 15_000);
    return () => clearInterval(id);
  }, [me]);

  const loginMutation = useMutation({
    mutationFn: async ({ login, password }: { login: string; password: string }) => {
      const response = await apiRequest("POST", "/api/auth/login", { email: login, password });
      return response.json();
    },
    onSuccess: async () => {
      // Also cleared here: a failed/abandoned session on this browser may have
      // left cached responses belonging to a different user.
      queryClient.clear();
      setSessionTakenOver(null);
      await loadMe();
      toast({ title: "Login successful" });
    },
    onError: () => {
      toast({ title: "Login failed", variant: "destructive" });
    },
  });

  const handleLogin = (login: string, password: string) => {
    loginMutation.mutate({ login, password });
  };

  const handleLogout = async () => {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } catch {
      /* best effort — clear local state regardless */
    }
    // MUST clear the query cache, not just the user. staleTime is Infinity, so
    // every camera list, event list and user list this person loaded stays in
    // memory and would be handed straight to the next person who signs in on
    // this browser without a refetch.
    queryClient.clear();
    setSessionTakenOver(null);
    setMe(null);
  };

  if (me === undefined) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (me === null) {
    return (
      <>
        {sessionTakenOver && (
          <div
            role="alert"
            className="fixed inset-x-0 top-0 z-50 bg-amber-500/95 px-4 py-3 text-center text-sm font-medium text-amber-950"
          >
            {sessionTakenOver} This tab was locked and its data cleared. Sign in again to continue.
          </div>
        )}
        <LoginPage onLogin={handleLogin} />
      </>
    );
  }

  // Route by role: the developer/platform owner gets the super-admin console;
  // everyone else gets the VMS operator app scoped to their org.
  return (
    <AuthContext.Provider value={me}>
      {me.role === "super_admin" ? (
        <SuperAdminConsole onLogout={handleLogout} />
      ) : (
        <Dashboard onLogout={handleLogout} username={me.username} />
      )}
    </AuthContext.Provider>
  );
}

// -------------------- WRAPPER ------------------------
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
