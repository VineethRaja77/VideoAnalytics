import { Search, Bell, User, Settings, LogOut, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

interface VmsNotification {
  id: string;
  type: string;
  message: string;
  cameraId?: string;
  cameraName?: string;
  createdAt: string;
}

const LAST_SEEN_KEY = "vms-notifications-last-seen";

interface TopHeaderProps {
  onSearch?: (query: string) => void;
  username?: string;
  onLogout?: () => void;
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const handleSave = async () => {
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (newPassword.length < 8) {
      toast({ title: "New password must be at least 8 characters", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      await apiRequest("POST", "/api/auth/change-password", { currentPassword, newPassword });
      toast({ title: "Password changed successfully" });
      reset();
      onClose();
    } catch (err: any) {
      toast({
        title: "Failed to change password",
        description: err?.message?.replace(/^\d+:\s*/, "") || undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Current Password</Label>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-2">
            <Label>New Password</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-2">
            <Label>Confirm New Password</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !currentPassword || !newPassword}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TopHeader({
  onSearch,
  username = "Admin User",
  onLogout,
}: TopHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<string>(
    () => localStorage.getItem(LAST_SEEN_KEY) || new Date(0).toISOString()
  );

  const { data: notifications = [] } = useQuery<VmsNotification[]>({
    queryKey: ["/api/notifications"],
    refetchInterval: 15_000,
  });

  const unreadCount = notifications.filter((n) => n.createdAt > lastSeen).length;

  const markAllSeen = () => {
    const now = new Date().toISOString();
    localStorage.setItem(LAST_SEEN_KEY, now);
    setLastSeen(now);
  };

  return (
    <header className="h-16 border-b border-border bg-card flex items-center justify-between px-4 gap-4">
      {/* LEFT SIDE: Sidebar Button + Search Bar */}
      <div className="flex items-center gap-4">
        <SidebarTrigger data-testid="button-sidebar-toggle" />

        <div className="relative w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search cameras..."
            className="pl-9 h-9"
            onChange={(e) => onSearch?.(e.target.value)}
            data-testid="input-search"
          />
        </div>
      </div>

      {/* RIGHT SIDE: Alerts + Profile Dropdown */}
      <div className="flex items-center gap-2">
        {/* Notification Bell */}
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) markAllSeen();
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="relative"
              data-testid="button-notifications"
            >
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <Badge
                  variant="destructive"
                  className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent className="w-96 max-h-96 overflow-y-auto" align="end">
            <DropdownMenuLabel>Notifications</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifications.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => (
                <DropdownMenuItem key={n.id} className="flex flex-col items-start gap-0.5 cursor-default">
                  <span className="text-sm">{n.message}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* PROFILE DROPDOWN */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" data-testid="button-profile">
              <User className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent className="w-56" align="end">
            <DropdownMenuLabel>
              <div className="font-medium">{username}</div>
              <div className="text-xs text-muted-foreground">Profile</div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuItem className="cursor-pointer" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4 mr-2" />
              Change Password
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              className="cursor-pointer text-red-600"
              onClick={onLogout}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ChangePasswordDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
