import { useState, useEffect, lazy, Suspense } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, apiRequest, apiRequestForPortal, currentPortal, type ApiError } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";

import LoginPage from "@/components/LoginPage";
import AppSidebar from "@/components/AppSidebar";
import TopHeader from "@/components/TopHeader";
const OperationsDashboard = lazy(() => import("@/components/OperationsDashboard"));
const EventsCenter = lazy(() => import("@/components/EventsCenter"));
const LiveView = lazy(() => import("@/components/LiveView"));
const AddCameraForm = lazy(() => import("@/components/AddCameraForm"));
const PlaybackView = lazy(() => import("@/components/PlaybackView"));
const LivePlayerModal = lazy(() => import("@/components/LivePlayerModal"));

const CameraList = lazy(() => import("@/components/cameralist"));
const SuperAdminConsole = lazy(() => import("@/components/SuperAdminConsole"));
const ClientSettings = lazy(() => import("@/components/ClientSettings"));
const AuditLogView = lazy(() => import("@/components/AuditLogView"));
const OrgUsers = lazy(() => import("@/components/OrgUsers"));
const AnalyticsSetupView = lazy(() => import("@/components/AnalyticsSetupView"));
import { Camera } from "@/components/CameraCard";
import { AuthContext, isSameSession, type AuthUser } from "@/lib/auth";
import { setAppTimezone } from "@shared/analyticsConfig";
import { AlertTriangle } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";

type View =
  | "login" | "operations" | "live" | "add-camera" | "camera-list" | "logout" | "playback"
  | "users" | "events" | "alerts" | "vehicles" | "faces" | "people" | "analytics-setup"
  | "audit" | "settings";

/** Sidebar path -> view. One table, so the sidebar and the router cannot drift. */
const VIEW_FOR_PATH: Record<string, View> = {
  "/operations": "operations",
  "/live": "live",
  "/add-camera": "add-camera",
  "/playback": "playback",
  "/cameralist": "camera-list",
  "/analytics-setup": "analytics-setup",
  "/events": "events",
  "/people": "people",
  "/alerts": "alerts",
  "/vehicles": "vehicles",
  "/faces": "faces",
  "/users": "users",
  "/audit": "audit",
  "/settings": "settings",
  "/logout": "logout",
};

const PATH_FOR_VIEW: Record<string, string> = Object.fromEntries(
  Object.entries(VIEW_FOR_PATH).map(([path, view]) => [view, path])
);

function Dashboard({ onLogout, username }: { onLogout: () => void; username: string }) {
  const [currentView, setCurrentView] = useState<View>("operations");
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");

  // Route chunks are loaded on demand. Eagerly prefetching every client page
  // after login made slower browsers/networks feel stuck because the clicked
  // page had to compete with a burst of background downloads.

  const { toast } = useToast();

  const {
    data: cameras = [],
    refetch: refetchCameras,
    error: camerasError,
  } = useQuery<Camera[], ApiError>({
    queryKey: ["/api/cameras"],
    refetchInterval: 10_000,
  });

  // A failed camera fetch is NOT an empty camera list.
  //
  // Without this the licence gate on /api/cameras produced the worst possible
  // screen: an organisation whose VMS licence was missing saw "No cameras added
  // yet — add your first camera to start monitoring", was unable to add one,
  // and was told by Analytics Setup to "add a camera first". Every message on
  // screen was wrong, and the real cause appeared nowhere.
  const cameraBlocked = camerasError ? camerasError.message : null;

  /** Views that cannot function without the camera list. */
  const CAMERA_DEPENDENT: View[] = [
    "live", "add-camera", "camera-list", "playback", "analytics-setup",
  ];


  const createCameraMutation = useMutation({
    mutationFn: async (cameraData: any) => {
      const response = await apiRequest("POST", "/api/cameras", cameraData);
      return response.json();
    },
    onSuccess: (data) => {
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
    if (path === "/logout") {
      onLogout();
      return;
    }

    setCurrentView(VIEW_FOR_PATH[path] || "operations");
  };

  const handleViewCamera = (camera: Camera) => {
    setSelectedCamera(camera);
    setIsPlayerOpen(true);
  };

  const handleAudioToggle = (camera: Camera) => {
    toast({ title: "Audio toggled" });
  };

  const handleSnapshot = (camera: Camera) => {
    toast({ title: "Snapshot saved" });
  };

  const handleFullscreen = (camera: Camera) => {
    handleViewCamera(camera);
  };

  const handleSaveCamera = (cameraData: any) => {
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
        {/* The real path, not a constant: with "/" hard-coded no menu item ever
            showed as active, so the sidebar never told anyone where they were. */}
        <AppSidebar
          currentPath={PATH_FOR_VIEW[currentView] ?? "/live"}
          onNavigate={handleNavigate}
        />

        <div className="flex flex-col flex-1 overflow-hidden">
          <TopHeader
            onSearch={(q) => {
              setSearchQuery(q);
            }}
            username={username}
            onLogout={onLogout}
          />

          <main className="flex-1 overflow-auto p-6"><Suspense fallback={<div role="status" className="p-8 text-sm text-muted-foreground">Loading view…</div>}>
            {cameraBlocked && (
              <div
                role="alert"
                className="mx-auto mb-6 flex max-w-5xl items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm"
              >
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <div>
                  <p className="font-medium text-destructive">
                    Cameras could not be loaded
                  </p>
                  {/* The server's own sentence: it distinguishes "never
                      licensed" from "expired" from "suspended", which is what
                      decides whether the client calls their provider or checks
                      their billing. */}
                  <p className="mt-1 text-foreground/80">{cameraBlocked}</p>
                </div>
              </div>
            )}

            {/* When the camera list is unreachable these screens can only
                mislead — "No cameras added yet", "Add a camera first" — so the
                explanation replaces them rather than sitting above them. The
                analytics event screens still work and are left alone. */}
            {cameraBlocked && CAMERA_DEPENDENT.includes(currentView) && (
              <p className="mx-auto max-w-5xl text-sm text-muted-foreground">
                This screen needs the camera list, so there is nothing to show
                until the problem above is resolved.
              </p>
            )}

            {currentView === "operations" && (
              <OperationsDashboard cameras={cameras} cameraBlocked={cameraBlocked} onNavigate={handleNavigate} />
            )}

            {!cameraBlocked && currentView === "live" && (
              <LiveView
                cameras={filteredCameras}
                onViewCamera={handleViewCamera}
                onAudioToggle={handleAudioToggle}
                onSnapshot={handleSnapshot}
                onFullscreen={handleFullscreen}
                onAddCamera={() => {
                  setCurrentView("add-camera");
                }}
              />
            )}

            {!cameraBlocked && currentView === "add-camera" && (
              <AddCameraForm
                onSave={handleSaveCamera}
                onCancel={() => {
                  setCurrentView("live");
                }}
              />
            )}

            {!cameraBlocked && currentView === "camera-list" && (
              <CameraList
                cameras={filteredCameras}
                onAddCamera={() => {
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

            {!cameraBlocked && currentView === "playback" && (
              <PlaybackView cameras={filteredCameras} />
            )}

            {!cameraBlocked && currentView === "analytics-setup" && (
              <AnalyticsSetupView cameras={cameras} />
            )}
            {currentView === "events" && <EventsCenter cameras={cameras} />}

            {currentView === "users" && <OrgUsers />}
            {currentView === "audit" && <AuditLogView />}
            {currentView === "settings" && <ClientSettings />}
          </Suspense></main>
        </div>
      </div>

      {isPlayerOpen && <Suspense fallback={null}><LivePlayerModal
        camera={selectedCamera}
        isOpen={isPlayerOpen}
        onClose={() => {
          setIsPlayerOpen(false);
        }}
      /></Suspense>}
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
      // Adopt the SITE's timezone before anything renders a time, so no screen
      // ever briefly shows the viewer's clock instead.
      if (user.timezone) setAppTimezone(user.timezone);
      setMe(user);
      return user;
    } catch {
      setMe(null);
      return null;
    }
  };

  useEffect(() => {
    document.documentElement.dataset.appBuild = "latency-no-prefetch-cache-20260914";
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
    mutationFn: async ({
      login,
      password,
      remember,
    }: {
      login: string;
      password: string;
      remember: boolean;
    }) => {
      const body = {
        email: login,
        password,
        // The login form has always collected this and it was dropped here, so
        // "Remember Me" changed nothing and everyone got a 30-day cookie. On a
        // shared control-room PC that is the opposite of what unticking it
        // means.
        remember,
      };
      let response = await apiRequest("POST", "/api/auth/login", body);
      const result = await response.json();

      // A super-admin signing in from the plain root URL initially talks to the
      // client portal, because the role is not known until after credentials are
      // checked. Move that login into the admin session cookie immediately;
      // otherwise the shell renders but every /api/admin request is 401.
      if (result?.user?.role === "super_admin" && currentPortal() !== "admin") {
        await apiRequestForPortal("client", "POST", "/api/auth/logout").catch(() => {});
        window.location.hash = "#/admin/overview";
        response = await apiRequestForPortal("admin", "POST", "/api/auth/login", body);
        return response.json();
      }

      return result;
    },
    onSuccess: async (result) => {
      // Also cleared here: a failed/abandoned session on this browser may have
      // left cached responses belonging to a different user.
      queryClient.clear();
      setSessionTakenOver(null);
      const user = result?.user as AuthUser | undefined;
      if (user) {
        if (user.timezone) setAppTimezone(user.timezone);
        setMe(user);
      } else {
        await loadMe();
      }
      toast({ title: "Login successful" });
    },
    onError: () => {
      toast({ title: "Login failed", variant: "destructive" });
    },
  });

  const handleLogin = (login: string, password: string, remember: boolean) => {
    loginMutation.mutate({ login, password, remember });
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
      <Suspense fallback={<div role="status" className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading application…</div>}>
      {me.role === "super_admin" ? (
        <SuperAdminConsole onLogout={handleLogout} />
      ) : (
        <Dashboard onLogout={handleLogout} username={me.username} />
      )}
    </Suspense>
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
