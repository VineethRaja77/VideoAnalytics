import { useQuery } from "@tanstack/react-query";
import { Activity, Camera, CheckCircle2, ShieldAlert, Video } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/datetime";
import type { Camera as CameraModel } from "@/components/CameraCard";

interface Props {
  cameras: CameraModel[];
  cameraBlocked?: string | null;
  onNavigate: (path: string) => void;
}

interface EventRow {
  id: string;
  cameraId: string | null;
  module: string;
  type: string;
  acknowledged: boolean;
  createdAt: string;
}

const label = (value: string) =>
  value.replace(/_/g, " ").replace(/\bppe\b/i, "PPE").replace(/\b\w/g, (c) => c.toUpperCase());

export default function OperationsDashboard({ cameras, cameraBlocked, onNavigate }: Props) {
  const auth = useAuth();
  const { data: events = [] } = useQuery<EventRow[]>({
    queryKey: ["/api/analytics/events", "operations", "latest"],
    queryFn: async () => (await apiRequest("GET", "/api/analytics/events?limit=12")).json(),
    refetchInterval: 15_000,
  });

  const online = cameras.filter((c: any) => c.status === "online" || c.status === "active").length;
  const openEvents = events.filter((e) => !e.acknowledged).length;
  const cameraName = (id: string | null) => cameras.find((c) => c.id === id)?.name ?? (id ? id.slice(0, 8) : "Unknown camera");

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">{auth.organizationName ?? "Operations"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Live camera health, analytics activity and daily actions.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onNavigate("/events")}>Events</Button>
          <Button onClick={() => onNavigate("/live")}>Open live view</Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Cameras</p><p className="mt-1 text-2xl font-semibold">{cameras.length}</p></div><Camera className="h-5 w-5 text-primary" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Online</p><p className="mt-1 text-2xl font-semibold">{online}</p></div><Video className="h-5 w-5 text-green-600" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Open events</p><p className="mt-1 text-2xl font-semibold">{openEvents}</p></div><ShieldAlert className="h-5 w-5 text-amber-600" /></CardContent></Card>
        <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">Licensed features</p><p className="mt-1 text-2xl font-semibold">{auth.licensedModules === "*" ? "All" : auth.licensedModules.length}</p></div><CheckCircle2 className="h-5 w-5 text-primary" /></CardContent></Card>
      </div>

      {cameraBlocked && (
        <Card className="border-destructive/40 bg-destructive/5"><CardContent className="p-5 text-sm text-destructive">{cameraBlocked}</CardContent></Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" /> Latest analytics activity</CardTitle></CardHeader>
          <CardContent className="p-0">
            {events.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">No analytics events yet. Enable analytics on cameras and events will appear here.</div>
            ) : (
              <div className="divide-y">
                {events.slice(0, 8).map((event) => (
                  <button key={event.id} className="grid w-full grid-cols-[1fr_auto] gap-3 p-4 text-left hover:bg-muted/50" onClick={() => onNavigate("/events")}> 
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{label(event.type)}</span>
                        <Badge variant="outline" className="text-xs">{label(event.module)}</Badge>
                        {!event.acknowledged && <Badge variant="secondary" className="text-xs">Open</Badge>}
                      </div>
                      <p className="mt-1 truncate text-sm text-muted-foreground">{cameraName(event.cameraId)}</p>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Quick actions</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("/add-camera")}>Add camera</Button>
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("/analytics-setup")}>Configure analytics</Button>
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("/cameralist")}>Manage cameras</Button>
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("/settings")}>Organization settings</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
