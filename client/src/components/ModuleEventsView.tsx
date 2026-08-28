// One events page per AI module.
//
// A single "Alerts" table hard-coded to PPE was wrong for two reasons: it
// fetched EVERY module's events and rendered them with PPE-specific columns
// (Visible / Compliance / Worker), so a vehicle crossing showed up as a blank
// "violation"; and a client licensed only for vehicle still saw a PPE-shaped
// screen.
//
// Each module now declares its own columns and queries with ?module=, which the
// API already supports. Licence gating lives in the sidebar (requiresModule);
// the server re-checks org scope on every request regardless.

import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, ImageIcon } from "lucide-react";
import { useAuth, canWrite } from "@/lib/auth";

export interface AnalyticsEvent {
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

export interface CameraLite {
  id: string;
  name: string;
}

export interface EventColumn {
  header: string;
  /** Cell renderer. Keep it defensive — `details` shape varies by worker version. */
  cell: (e: AnalyticsEvent) => React.ReactNode;
  className?: string;
}

interface Props {
  module: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  columns: EventColumn[];
  cameras: CameraLite[];
  /** Acknowledgement only makes sense for alert-like modules (PPE, unknown faces). */
  ackable?: boolean;
  emptyText?: string;
}

export const prettyType = (t: string) =>
  t.replace(/_/g, " ").replace(/\bppe\b/i, "PPE");

export function SnapshotCell({ event }: { event: AnalyticsEvent }) {
  if (!event.snapshot) return <span className="text-muted-foreground">—</span>;
  // Never link the raw filesystem path: images are served through an
  // authenticated, org-scoped route keyed on the EVENT id.
  return (
    <a
      href={`/api/analytics/events/${event.id}/snapshot`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      <ImageIcon className="h-4 w-4" /> View
    </a>
  );
}

export default function ModuleEventsView({
  module,
  title,
  subtitle,
  icon,
  columns,
  cameras,
  ackable = true,
  emptyText = "No events yet.",
}: Props) {
  const auth = useAuth();
  const writable = canWrite(auth.role);

  const { data: events = [] } = useQuery<AnalyticsEvent[]>({
    // Module is part of the key so switching pages does not show stale rows
    // from the previous module.
    queryKey: ["/api/analytics/events", module],
    queryFn: async () =>
      (await apiRequest("GET", `/api/analytics/events?module=${module}&limit=200`)).json(),
    refetchInterval: 15_000,
  });

  const ack = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/analytics/events/${id}/ack`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/events", module] }),
  });

  const colCount = columns.length + (ackable ? 1 : 0);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        {icon} {title}
      </h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{subtitle}</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                {columns.map((c) => (
                  <th key={c.header} className={`p-3 ${c.className ?? ""}`}>
                    {c.header}
                  </th>
                ))}
                {ackable && <th className="p-3 text-right">Status</th>}
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="p-6 text-center text-muted-foreground">
                    {emptyText}
                  </td>
                </tr>
              )}
              {events.map((e) => (
                <tr
                  key={e.id}
                  className={`border-b last:border-0 ${e.acknowledged ? "opacity-60" : ""}`}
                  data-testid={`event-${e.id}`}
                >
                  {columns.map((c) => (
                    <td key={c.header} className={`p-3 ${c.className ?? ""}`}>
                      {c.cell(e)}
                    </td>
                  ))}
                  {ackable && (
                    <td className="p-3 text-right">
                      {e.acknowledged ? (
                        <Badge variant="secondary" className="text-xs">
                          Acknowledged
                        </Badge>
                      ) : writable ? (
                        // Employees can read but not acknowledge — mirrors the
                        // server's requireWriteAccess on the ack route.
                        <Button size="sm" variant="outline" onClick={() => ack.mutate(e.id)}>
                          <Check className="h-4 w-4 mr-1" /> Ack
                        </Button>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          Open
                        </Badge>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/** Shared "which camera" cell. */
export function cameraName(cameras: CameraLite[], id: string | null): string {
  return cameras.find((c) => c.id === id)?.name ?? (id ? id.slice(0, 8) : "—");
}
