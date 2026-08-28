import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck, RefreshCw } from "lucide-react";

interface AuditRow {
  id: string;
  actorUsername: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetLabel: string | null;
  targetId: string | null;
  outcome: string;
  detail: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

/**
 * Grouped so an admin can find what they came for. The two questions people
 * actually arrive with are "who watched that footage?" and "who changed this?",
 * so footage access is its own group rather than buried in a flat list.
 */
const ACTION_GROUPS: Record<string, string[]> = {
  "Footage access": ["recording_viewed", "recording_exported", "snapshot_viewed"],
  "Sign-in activity": ["login", "login_failed", "logout", "password_changed"],
  "Cameras": ["camera_created", "camera_updated", "camera_deleted", "analytics_binding_changed"],
  "Users": ["user_created", "user_updated", "user_disabled"],
  "Licensing": ["license_issued", "license_updated", "license_revoked", "ingest_token_minted"],
};

/** Plain English. An audit log full of snake_case is not a compliance artefact. */
const ACTION_LABELS: Record<string, string> = {
  login: "Signed in",
  login_failed: "Failed sign-in",
  logout: "Signed out",
  password_changed: "Password changed",
  user_created: "User created",
  user_updated: "User updated",
  user_disabled: "User disabled",
  camera_created: "Camera added",
  camera_updated: "Camera settings changed",
  camera_deleted: "Camera removed",
  recording_viewed: "Recording viewed",
  recording_exported: "Recording exported",
  recording_deleted: "Recording deleted",
  snapshot_viewed: "Snapshot viewed",
  analytics_event_acknowledged: "Alert acknowledged",
  analytics_binding_changed: "Analytics changed",
  license_issued: "Licence issued",
  license_updated: "Licence updated",
  license_revoked: "Licence revoked",
  ingest_token_minted: "Worker token rotated",
  organization_created: "Organisation created",
  organization_updated: "Organisation updated",
  access_denied: "Access denied",
};

function label(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

function outcomeBadge(outcome: string) {
  if (outcome === "denied") return <Badge variant="destructive">denied</Badge>;
  if (outcome === "error") return <Badge variant="destructive">error</Badge>;
  return <Badge variant="secondary">ok</Badge>;
}

/** Compact but unambiguous — an auditor needs the date, not "2 hours ago". */
function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/**
 * Audit trail, client-admin and above.
 *
 * Server-side this is org-scoped and fails closed, so this component can never
 * show another tenant's activity regardless of what it asks for.
 */
export default function AuditLogView() {
  const [group, setGroup] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data: rows = [], isFetching, refetch } = useQuery<AuditRow[]>({
    queryKey: ["/api/audit"],
    queryFn: async () => (await apiRequest("GET", "/api/audit?limit=500")).json(),
  });

  const visible = rows.filter((r) => {
    if (group !== "all" && !ACTION_GROUPS[group]?.includes(r.action)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (r.actorUsername ?? "").toLowerCase().includes(q) ||
      (r.targetLabel ?? "").toLowerCase().includes(q) ||
      label(r.action).toLowerCase().includes(q) ||
      (r.ipAddress ?? "").includes(q)
    );
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" />
          Audit trail
        </CardTitle>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search user, camera, IP…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56"
          />
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All activity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All activity</SelectItem>
              {Object.keys(ACTION_GROUPS).map((g) => (
                <SelectItem key={g} value={g}>{g}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? "No activity recorded yet."
              : "No entries match this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Who</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                  <th className="py-2 pr-4 font-medium">Target</th>
                  <th className="py-2 pr-4 font-medium">Result</th>
                  <th className="py-2 pr-4 font-medium">From</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-muted-foreground">
                      {when(r.createdAt)}
                    </td>
                    <td className="py-2 pr-4">
                      <div className="font-medium">{r.actorUsername ?? "—"}</div>
                      {r.actorRole && (
                        <div className="text-xs text-muted-foreground">
                          {r.actorRole.replace(/_/g, " ")}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-4">{label(r.action)}</td>
                    <td className="py-2 pr-4">
                      <div>{r.targetLabel ?? r.targetType ?? "—"}</div>
                      {/* changedFields is the useful half of a camera update:
                          the values themselves are never stored. */}
                      {Array.isArray((r.detail as any)?.changedFields) && (
                        <div className="text-xs text-muted-foreground">
                          changed: {((r.detail as any).changedFields as string[]).join(", ")}
                        </div>
                      )}
                      {(r.detail as any)?.reason && (
                        <div className="text-xs text-muted-foreground">
                          {String((r.detail as any).reason).replace(/_/g, " ")}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-4">{outcomeBadge(r.outcome)}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                      {r.ipAddress ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="pt-4 text-xs text-muted-foreground">
          Showing the {visible.length} most recent of up to 500 entries. The trail is
          append-only and cannot be edited or deleted from this screen.
        </p>
      </CardContent>
    </Card>
  );
}
