import { Search, Bell, User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";

interface TopHeaderProps {
  notificationCount?: number;
  onSearch?: (query: string) => void;
}

export default function TopHeader({ notificationCount = 0, onSearch }: TopHeaderProps) {
  return (
    <header className="h-16 border-b border-border bg-card flex items-center justify-between px-4 gap-4">
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

      <div className="flex items-center gap-2">
        <Button size="icon" variant="ghost" className="relative" data-testid="button-notifications">
          <Bell className="h-5 w-5" />
          {notificationCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
            >
              {notificationCount}
            </Badge>
          )}
        </Button>
        <Button size="icon" variant="ghost" data-testid="button-profile">
          <User className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}
