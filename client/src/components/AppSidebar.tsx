import { Video, Plus, PlaySquare, List, LogOut, Users, ShieldAlert, Car, ScanFace,
  ShieldCheck,
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
import { useAuth, canWrite, canManageOrgUsers, hasModule } from "@/lib/auth";

interface MenuItem {
  title: string;
  icon: typeof Video;
  path: string;
  requiresWrite?: boolean;
  requiresAdmin?: boolean;
  requiresModule?: string; // licence FEATURE key (see MODULE_FEATURES in shared/schema)
}

const allMenuItems: MenuItem[] = [
  { title: "Live", icon: Video, path: "/live" },
  { title: "Add Camera", icon: Plus, path: "/add-camera", requiresWrite: true },
  { title: "Camera List", icon: List, path: "/cameralist" },
  { title: "Playback", icon: PlaySquare, path: "/playback" },
  { title: "PPE Alerts", icon: ShieldAlert, path: "/alerts", requiresModule: "ppe_compliance" },
  { title: "Vehicles", icon: Car, path: "/vehicles", requiresModule: "vehicle_count" },
  { title: "Faces", icon: ScanFace, path: "/faces", requiresModule: "face_recognition" },
  { title: "Users", icon: Users, path: "/users", requiresAdmin: true },
  // Admin-only: a manager can change things but must not review who did what.
  { title: "Audit Trail", icon: ShieldCheck, path: "/audit", requiresAdmin: true },
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
    if (item.requiresModule && !hasModule(auth, item.requiresModule)) return false;
    return true;
  });

  return (
    <Sidebar>
      <SidebarHeader className="p-6 border-b border-sidebar-border">
        <div className="text-primary text-2xl font-bold">
          HYPERSPARK
        </div>
        <p className="text-xs text-muted-foreground mt-1">Video Management</p>
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
                    className="h-11"
                    data-testid={`nav-${item.title.toLowerCase().replace(" ", "-")}`}
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
