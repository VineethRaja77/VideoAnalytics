import { Video, Plus, PlaySquare } from "lucide-react";
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

const menuItems = [
  {
    title: "Live",
    icon: Video,
    path: "/live",
  },
  {
    title: "Add Camera",
    icon: Plus,
    path: "/add-camera",
  },
  {
    title: "Playback",
    icon: PlaySquare,
    path: "/playback",
  },
];

interface AppSidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export default function AppSidebar({ currentPath, onNavigate }: AppSidebarProps) {
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
