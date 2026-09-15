import {
  Video, Plus, PlaySquare, List, LogOut, Users, ShieldAlert, LayoutDashboard,
  ShieldCheck, SlidersHorizontal, Settings,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { MODULE_FEATURES } from "@shared/schema";
import {
  useAuth, canWrite, canManageOrgUsers, hasAnyModule,
} from "@/lib/auth";

interface MenuItem {
  title: string;
  icon: typeof Video;
  path: string;
  requiresWrite?: boolean;
  requiresAdmin?: boolean;
  /**
   * Licence FEATURE keys, ANY of which reveals this item.
   *
   * A list, not a single key: a screen shows a whole module's events, so gating
   * it on one feature hid it from clients who had bought a different feature of
   * the same module. A client licensed only for wrong-way driving had no
   * Vehicles menu item at all — they were paying for something with no screen.
   */
  requiresAnyFeature?: readonly string[];
}

/** Every camera analytic — used to decide whether Analytics Setup is useful. */
const ALL_CAMERA_FEATURES = Object.entries(MODULE_FEATURES)
  .filter(([mod]) => mod !== "sensors")
  .flatMap(([, feats]) => feats as readonly string[]);

const allMenuItems: MenuItem[] = [
  { title: "Operations", icon: LayoutDashboard, path: "/operations" },
  { title: "Live", icon: Video, path: "/live" },
  { title: "Add Camera", icon: Plus, path: "/add-camera", requiresWrite: true },
  { title: "Cameras", icon: List, path: "/cameralist" },
  { title: "Playback", icon: PlaySquare, path: "/playback" },
  {
    title: "Analytics Setup",
    icon: SlidersHorizontal,
    path: "/analytics-setup",
    requiresWrite: true,
    requiresAnyFeature: ALL_CAMERA_FEATURES,
  },
  {
    title: "Events",
    icon: ShieldAlert,
    path: "/events",
    requiresAnyFeature: ALL_CAMERA_FEATURES,
  },
  { title: "Users", icon: Users, path: "/users", requiresAdmin: true },
  // Admin-only: a manager can change things but must not review who did what.
  { title: "Audit Trail", icon: ShieldCheck, path: "/audit", requiresAdmin: true },
  { title: "Settings", icon: Settings, path: "/settings" },
  { title: "Logout", icon: LogOut, path: "/logout" },
];

interface AppSidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export default function AppSidebar({ currentPath, onNavigate }: AppSidebarProps) {
  const auth = useAuth();
  const menuItems = allMenuItems.filter((item) => {
    if (item.requiresWrite && !canWrite(auth.role)) return false;
    if (item.requiresAdmin && !canManageOrgUsers(auth.role)) return false;
    if (item.requiresAnyFeature && !hasAnyModule(auth, item.requiresAnyFeature)) {
      return false;
    }
    return true;
  });

  return (
    <Sidebar>
      <SidebarHeader className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          {auth.organizationLogoDataUrl && <img src={auth.organizationLogoDataUrl} alt="Organization logo" className="h-10 w-10 rounded-md border object-contain" />}
          <div className="min-w-0">
            <div className="truncate text-primary text-xl font-bold">{auth.organizationName ?? "HYPERSPARK"}</div>
            <p className="text-xs text-muted-foreground mt-1">Video Management</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    onClick={() => onNavigate(item.path)}
                    isActive={currentPath === item.path}
                    className="h-11 cursor-pointer"
                    data-testid={`nav-${item.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                  >
                    <item.icon className="h-5 w-5" />
                    <span className="text-sm font-medium">{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
