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

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Check, ChevronLeft, ChevronRight, Download, FilterX, ImageIcon,
} from "lucide-react";
import { useAuth, canWrite } from "@/lib/auth";
import { siteDayEnd, siteDayStart, timezoneLabel } from "@/lib/datetime";

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
  /** Suppress the page heading when the module is rendered inside its own
   *  tabbed screen, which supplies one already. Two identical headings stacked
   *  on top of each other read as a rendering bug. */
  hideHeading?: boolean;
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
  hideHeading = false,
}: Props) {
  const auth = useAuth();
  const writable = canWrite(auth.role);

  // The list used to be "the newest 200, and nothing else", which meant that a
  // week after go-live a client could not answer "what happened at Gate 2 on
  // Tuesday" — the question a security system exists to answer.
  const [cameraId, setCameraId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);

  const PAGE = 50;
  const filters = useMemo(() => {
    const p = new URLSearchParams({ module, limit: String(PAGE) });
    if (cameraId) p.set("cameraId", cameraId);
    if (status) p.set("acknowledged", status);
    // The picker gives a calendar DATE, and the operator means that day AT THE
    // SITE. Reading it as UTC midnight would shift the window by the site's
    // offset — at an Indian site, "the 13th" would start at 05:30 on the 13th
    // and quietly include the tail of the 12th.
    if (from) p.set("from", siteDayStart(from).toISOString());
    // Inclusive "to", expressed as the exclusive start of the next day —
    // otherwise "to = today" silently excludes today.
    if (to) p.set("to", siteDayEnd(to).toISOString());
    return p;
  }, [module, cameraId, status, from, to]);

  const filtered = !!(cameraId || status || from || to);

  const { data, isFetching } = useQuery<{ rows: AnalyticsEvent[]; total: number }>({
    // Every filter is in the key, so a stale page never renders under new
    // filters — which would show rows that do not match what is on screen.
    queryKey: ["/api/analytics/events", module, filters.toString(), page],
    queryFn: async () => {
      const p = new URLSearchParams(filters);
      p.set("offset", String(page * PAGE));
      const res = await apiRequest("GET", `/api/analytics/events?${p.toString()}`);
      return {
        rows: await res.json(),
        total: Number(res.headers.get("X-Total-Count") ?? 0),
      };
    },
    // Polling only makes sense on the newest page; paging back through history
    // should not shift under the reader.
    refetchInterval: page === 0 ? 15_000 : false,
  });

  const events = data?.rows ?? [];
  const total = data?.total ?? 0;

  const ack = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/analytics/events/${id}/ack`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/events", module] }),
  });

  const clearFilters = () => {
    setCameraId("");
    setFrom("");
    setTo("");
    setStatus("");
    setPage(0);
  };

  const exportCsv = () => {
    const p = new URLSearchParams(filters);
    p.delete("limit");
    // A plain navigation, so the browser handles the download and the session
    // cookie goes with it — a fetch() would need the blob juggling for nothing.
    window.location.href = `/api/analytics/events.csv?${p.toString()}`;
  };

  const colCount = columns.length + (ackable ? 1 : 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {!hideHeading && (
        <h2 className="text-xl font-semibold flex items-center gap-2">
          {icon} {title}
        </h2>
      )}

      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">{subtitle}</CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                times in {timezoneLabel()}
              </span>
              <span className="text-xs text-muted-foreground" data-testid="events-total">
                {total === 0
                  ? "No matching events"
                  : `Showing ${page * PAGE + 1}–${Math.min((page + 1) * PAGE, total)} of ${total}`}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="cursor-pointer"
                disabled={total === 0}
                onClick={exportCsv}
                data-testid="button-export-csv"
              >
                <Download className="mr-1 h-4 w-4" />
                Export CSV
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <Label htmlFor="filter-camera" className="text-xs text-muted-foreground">
                Camera
              </Label>
              <Select
                value={cameraId || "all"}
                onValueChange={(v) => {
                  setCameraId(v === "all" ? "" : v);
                  setPage(0);
                }}
              >
                <SelectTrigger id="filter-camera" className="cursor-pointer" data-testid="filter-camera">
                  <SelectValue placeholder="All cameras" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="cursor-pointer">All cameras</SelectItem>
                  {cameras.map((c) => (
                    <SelectItem key={c.id} value={c.id} className="cursor-pointer">
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="filter-from" className="text-xs text-muted-foreground">From</Label>
              <Input
                id="filter-from"
                type="date"
                value={from}
                className="cursor-pointer"
                onChange={(e) => { setFrom(e.target.value); setPage(0); }}
                data-testid="filter-from"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="filter-to" className="text-xs text-muted-foreground">To</Label>
              <Input
                id="filter-to"
                type="date"
                value={to}
                className="cursor-pointer"
                onChange={(e) => { setTo(e.target.value); setPage(0); }}
                data-testid="filter-to"
              />
            </div>

            {ackable && (
              <div className="space-y-1">
                <Label htmlFor="filter-status" className="text-xs text-muted-foreground">
                  Status
                </Label>
                <Select
                  value={status || "any"}
                  onValueChange={(v) => { setStatus(v === "any" ? "" : v); setPage(0); }}
                >
                  <SelectTrigger id="filter-status" className="cursor-pointer" data-testid="filter-status">
                    <SelectValue placeholder="Any" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any" className="cursor-pointer">Any</SelectItem>
                    <SelectItem value="false" className="cursor-pointer">Open</SelectItem>
                    <SelectItem value="true" className="cursor-pointer">Acknowledged</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-end">
              <Button
                variant="ghost"
                className="cursor-pointer"
                disabled={!filtered}
                onClick={clearFilters}
                data-testid="button-clear-filters"
              >
                <FilterX className="mr-1 h-4 w-4" />
                Clear
              </Button>
            </div>
          </div>
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
                    {/* "Nothing has happened" and "nothing matches your filter"
                        are different problems and need different next steps. */}
                    {filtered
                      ? "No events match these filters. Widen the dates or clear them."
                      : emptyText}
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

          {total > PAGE && (
            <div className="flex items-center justify-between border-t p-3">
              <Button
                size="sm"
                variant="outline"
                className="cursor-pointer"
                disabled={page === 0 || isFetching}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                data-testid="button-prev-page"
              >
                <ChevronLeft className="mr-1 h-4 w-4" /> Newer
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page + 1} of {Math.ceil(total / PAGE)}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="cursor-pointer"
                disabled={(page + 1) * PAGE >= total || isFetching}
                onClick={() => setPage((p) => p + 1)}
                data-testid="button-next-page"
              >
                Older <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Shared "which camera" cell. */
export function cameraName(cameras: CameraLite[], id: string | null): string {
  return cameras.find((c) => c.id === id)?.name ?? (id ? id.slice(0, 8) : "—");
}
