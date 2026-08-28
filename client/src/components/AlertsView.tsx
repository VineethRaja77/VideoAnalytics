import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldAlert, Check } from "lucide-react";
import { useAuth, canWrite } from "@/lib/auth";

interface AnalyticsEvent {
  id: string;
  cameraId: string | null;
  module: string;
  type: string;
  trackId: number | null;
  details: any;
  snapshot: string | null;
  acknowledged: boolean;
  createdAt: string;
}

interface CameraLite { id: string; name: string; }

const prettyType = (t: string) => t.replace(/_/g, " ").replace(/\bppe\b/i, "PPE");

export default function AlertsView({ cameras }: { cameras: CameraLite[] }) {
  const auth = useAuth();
  const writable = canWrite(auth.role);
  const camName = (id: string | null) => cameras.find((c) => c.id === id)?.name ?? (id ? id.slice(0, 8) : "—");

  const { data: events = [] } = useQuery<AnalyticsEvent[]>({
    // Scope to PPE. Without ?module= this table showed vehicle crossings and
    // face events rendered with PPE columns (blank Violation/Compliance).
    queryKey: ["/api/analytics/events", "ppe"],
    queryFn: async () =>
      (await apiRequest("GET", "/api/analytics/events?module=ppe&limit=200")).json(),
    refetchInterval: 15_000,
  });

  const ack = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/analytics/events/${id}/ack`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/analytics/events", "ppe"] }),
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-primary" /> Safety Alerts
      </h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PPE compliance violations</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">Time</th>
                <th className="p-3">Camera</th>
                <th className="p-3">Violation</th>
                <th className="p-3">Visible</th>
                <th className="p-3">Compliance</th>
                <th className="p-3">Worker</th>
                <th className="p-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No alerts yet.</td></tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className={`border-b last:border-0 ${e.acknowledged ? "opacity-60" : ""}`} data-testid={`alert-${e.id}`}>
                  <td className="p-3 whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="p-3">{camName(e.cameraId)}</td>
                  <td className="p-3">
                    <Badge variant="destructive" className="capitalize">{prettyType(e.type)}</Badge>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">{(e.details?.visible || []).join(", ") || "—"}</td>
                  <td className="p-3 text-xs">
                    {e.details?.compliance
                      ? Object.entries(e.details.compliance).map(([k, v]) => (
                          <span key={k} className="mr-2">
                            {k}: <span className={v === "missing" ? "text-destructive" : v === "present" ? "text-green-600" : "text-muted-foreground"}>{String(v)}</span>
                          </span>
                        ))
                      : "—"}
                  </td>
                  <td className="p-3">{e.trackId != null ? `#${e.trackId}` : "—"}</td>
                  <td className="p-3 text-right">
                    {e.acknowledged ? (
                      <Badge variant="secondary" className="text-xs">Acknowledged</Badge>
                    ) : writable ? (
                      <Button size="sm" variant="outline" onClick={() => ack.mutate(e.id)}>
                        <Check className="h-4 w-4 mr-1" /> Ack
                      </Button>
                    ) : (
                      <Badge variant="outline" className="text-xs">Open</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
