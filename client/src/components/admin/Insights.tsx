import { useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Building2,
  Camera,
  CheckCircle2,
  Cpu,
  KeyRound,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiJson } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import {
  formatDateTime,
  formatDateTimeSeconds,
  siteDayStart,
  siteDayEnd,
  timezoneLabel,
} from "@/lib/datetime";
import {
  Client,
  Page,
  Org,
  Navigate,
  Panel,
  QueryState,
  Status,
  UsageBar,
  Pager,
  Empty,
  FilterSelect,
  FormDialog,
  FormSpec,
  useAdminQuery,
  useDebounce,
  refreshAdmin,
  number,
  tableClass,
} from "./common";


async function imageToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Upload an image file.");
  if (file.size > 1_500_000) throw new Error("Logo must be under 1.5 MB.");
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the logo file."));
    reader.readAsDataURL(file);
  });
}

interface OverviewData {
  clients: number;
  activeClients: number;
  cameras: number;
  online: number;
  offline: number;
  unknown: number;
  licenseStats: { active: number; expiring: number };
  pressureCount: number;
  pressure: Client[];
  recentClients: Client[];
  checkedAt: string;
}
export interface SystemData {
  state: string;
  checkedAt: string | null;
  checking: boolean;
  services: {
    key: string;
    label: string;
    state: string;
    detail: string;
    latencyMs?: number;
  }[];
  host: {
    processUptimeSeconds: number;
    hostUptimeSeconds: number;
    nodeVersion: string;
    platform: string;
    cpus: number;
    loadAverage: number[];
    memoryTotalGb: number;
    memoryFreeGb: number;
    timezone: string;
    deploymentMode: string;
    environment: string;
  };
}
export function Overview({ navigate }: { navigate: Navigate }) {
  const query = useAdminQuery<OverviewData>(
    "/api/admin/console/overview",
    30000,
  );
  const system = useAdminQuery<SystemData>("/api/admin/system", 15000);
  const data = query.data;
  const cards = [
    {
      label: "Clients",
      value: data?.clients,
      note: `${data?.activeClients ?? 0} active organizations`,
      icon: Building2,
      go: "clients",
    },
    {
      label: "Camera usage",
      value: data?.cameras,
      note: `${data?.online ?? 0} online · ${data?.offline ?? 0} offline · ${data?.unknown ?? 0} unknown`,
      icon: Camera,
      go: "clients",
    },
    {
      label: "Active licenses",
      value: data?.licenseStats.active,
      note: "Active or trial, within expiry",
      icon: KeyRound,
      go: "licensing",
    },
    {
      label: "Renewals due",
      value: data?.licenseStats.expiring,
      note: "Expiring in the next 30 days",
      icon: Activity,
      go: "licensing",
    },
  ] as const;
  return (
    <QueryState query={query}>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((c) => (
            <button
              key={c.label}
              onClick={() => navigate(c.go)}
              className="group rounded-xl border bg-card p-5 text-left shadow-sm transition-colors hover:border-blue-300"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  {c.label}
                </span>
                <c.icon className="h-4 w-4 text-blue-500" />
              </div>
              <p className="my-3 text-3xl font-semibold tracking-tight tabular-nums">
                {number(c.value ?? 0)}
              </p>
              <p className="flex items-center justify-between text-xs text-muted-foreground">
                {c.note}
                <ArrowUpRight className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100" />
              </p>
            </button>
          ))}
        </div>
        <div className="grid items-start gap-6 xl:grid-cols-[1.6fr_1fr]">
          <Panel
            title="Clients needing attention"
            description={`${data?.pressureCount ?? 0} organizations approaching or exceeding an allowance`}
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("clients")}
              >
                View clients
                <ArrowUpRight className="ml-2 h-4 w-4" />
              </Button>
            }
          >
            {data?.pressure.length ? (
              <div className="divide-y">
                {data.pressure.map((c) => (
                  <div className="p-5" key={c.organizationId}>
                    <button
                      onClick={() =>
                        navigate("clients", { client: c.organizationId })
                      }
                      className="mb-4 font-semibold text-sm hover:text-primary"
                    >
                      {c.name}{" "}
                      <ArrowUpRight className="ml-1 inline h-3.5 w-3.5" />
                    </button>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {c.usage
                        .filter((u) =>
                          ["warning", "critical", "exceeded"].includes(u.level),
                        )
                        .map((u) => (
                          <UsageBar key={u.key} usage={u} />
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-6 py-12 text-center">
                <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-emerald-500" />
                <p className="text-sm font-medium">No allowance alerts</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  No configured allowance is currently at a warning level.
                </p>
              </div>
            )}
          </Panel>
          <Panel
            title="Platform health"
            description="Service-level signals across the deployment"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("system")}
              >
                Details
              </Button>
            }
          >
            <QueryState query={system}>
              <div className="divide-y">
                {system.data?.services.map((s) => (
                  <div
                    key={s.key}
                    className="flex items-center justify-between gap-3 px-5 py-3.5"
                  >
                    <span className="text-sm">{s.label}</span>
                    <Status value={s.state} />
                  </div>
                ))}
              </div>
              <p className="border-t px-5 py-3 text-[11px] text-muted-foreground">
                {system.data?.checkedAt
                  ? `Checked ${formatDateTime(system.data.checkedAt)}`
                  : "Initial service checks in progress."}
              </p>
            </QueryState>
          </Panel>
        </div>
        <Panel
          title="Recently created clients"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("clients")}
            >
              Open directory
            </Button>
          }
        >
          {data?.recentClients.length ? (
            <div className="grid divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-3">
              {data.recentClients.map((c) => (
                <button
                  key={c.organizationId}
                  onClick={() =>
                    navigate("clients", { client: c.organizationId })
                  }
                  className="flex items-center justify-between gap-3 p-5 text-left hover:bg-muted/30"
                >
                  <div>
                    <p className="text-sm font-semibold">{c.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.usage[0].used} cameras · {c.usage[1].used} users
                    </p>
                  </div>
                  <Status value={c.status} />
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title="Your client directory is empty"
              description="Create a client to begin onboarding."
            />
          )}
        </Panel>
        <p className="text-xs text-muted-foreground">
          Usage updated {formatDateTime(data?.checkedAt)} · Refreshes every 30
          seconds while this page is open.
        </p>
      </div>
    </QueryState>
  );
}
interface ModelReport {
  checkedAt: string | null;
  checking: boolean;
  modules: {
    module: string;
    ok: boolean;
    reason?: string;
    artifacts: {
      file: string;
      present: boolean;
      matches?: boolean;
      sha256?: string;
      expected?: string;
      sizeBytes?: number;
    }[];
  }[];
}
export function Models() {
  const query = useAdminQuery<ModelReport>("/api/admin/console-models", 5000);
  return (
    <QueryState query={query}>
      <div className="space-y-5">
        <div className="flex flex-wrap justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {query.data?.checkedAt
              ? `Last verified ${formatDateTime(query.data.checkedAt)}`
              : "Checking installed model artifacts…"}
            {query.data?.checking && " · Verification in progress"}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh status
          </Button>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {query.data?.modules.map((m) => (
            <Panel
              key={m.module}
              title={`${m.module[0].toUpperCase()}${m.module.slice(1)} analytics`}
              action={
                <Status
                  value={
                    !m.ok
                      ? "failed"
                      : m.artifacts.some((a) => a.matches === undefined)
                        ? "unverified"
                        : "verified"
                  }
                />
              }
            >
              <div className="space-y-4 p-5">
                <p className="text-xs text-muted-foreground">
                  {m.reason ??
                    (m.artifacts.length
                      ? "Installed artifacts and SHA-256 verification results."
                      : "Model-free analytics. No weight files required.")}
                </p>
                {m.artifacts.map((a) => (
                  <div className="rounded-lg border p-3 text-xs" key={a.file}>
                    <div className="flex items-start justify-between gap-3">
                      <span className="break-all font-mono">{a.file}</span>
                      <Status
                        value={
                          !a.present
                            ? "missing"
                            : a.matches === false
                              ? "failed"
                              : a.matches
                                ? "verified"
                                : "unverified"
                        }
                      />
                    </div>
                    <p className="mt-2 text-muted-foreground">
                      {a.sizeBytes === undefined
                        ? "File unavailable"
                        : `${number(a.sizeBytes / 1024 ** 2)} MB`}
                    </p>
                    {a.sha256 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-primary">
                          Checksum details
                        </summary>
                        <p className="mt-2 break-all font-mono leading-relaxed">
                          Observed: {a.sha256}
                          <br />
                          Expected: {a.expected ?? "No trusted manifest entry"}
                        </p>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Verification runs in the background and is cached for up to five
          minutes. Model deployment is managed on the host; client module access
          is managed in Licensing.
        </p>
      </div>
    </QueryState>
  );
}
export function System() {
  const query = useAdminQuery<SystemData>("/api/admin/system", 5000);
  const h = query.data?.host;
  const uptime = (seconds?: number) =>
    seconds === undefined
      ? "—"
      : `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return (
    <QueryState query={query}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-5">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-blue-600" />
            <div>
              <p className="font-semibold text-sm">Deployment status</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {query.data?.checkedAt
                  ? `Checked ${formatDateTimeSeconds(query.data.checkedAt)}`
                  : "Initial checks are in progress"}
                {query.data?.checking && " · Updating"}
              </p>
            </div>
          </div>
          <Status value={query.data?.state ?? "unknown"} />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {query.data?.services.map((s) => (
            <Panel
              key={s.key}
              title={s.label}
              action={<Status value={s.state} />}
            >
              <div className="p-5">
                <p className="min-h-12 text-sm leading-relaxed text-muted-foreground">
                  {s.detail}
                </p>
                {s.latencyMs !== undefined && (
                  <p className="mt-3 text-xs font-medium">
                    Check duration: {s.latencyMs} ms
                  </p>
                )}
              </div>
            </Panel>
          ))}
        </div>
        <Panel
          title="Host & runtime"
          description="Observed deployment information. Service-check duration is not an application latency benchmark."
        >
          <dl className="grid gap-6 p-6 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Process uptime", uptime(h?.processUptimeSeconds)],
              ["Host uptime", uptime(h?.hostUptimeSeconds)],
              [
                "Memory",
                `${h?.memoryFreeGb ?? "—"} / ${h?.memoryTotalGb ?? "—"} GB free`,
              ],
              ["CPU", `${h?.cpus ?? "—"} logical cores`],
              ["Load (1 / 5 / 15 min)", h?.loadAverage.join(" / ")],
              ["Runtime", h?.nodeVersion],
              ["Timezone", h?.timezone],
              ["Deployment", h?.deploymentMode],
            ].map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs text-muted-foreground">{key}</dt>
                <dd className="mt-2 text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </QueryState>
  );
}
interface AuditRow {
  id: string;
  clientName: string | null;
  actorUsername: string | null;
  actorRole: string | null;
  action: string;
  targetLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  ipAddress: string | null;
  createdAt: string;
  detail: unknown;
}
export function Audit() {
  const [search, setSearch] = useState("");
  const term = useDebounce(search);
  const [page, setPage] = useState(1);
  const [org, setOrg] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const orgs = useAdminQuery<Org[]>("/api/admin/organizations");
  const invalid = Boolean(from && to && from > to);
  const query = useAdminQuery<Page<AuditRow>>(
    `/api/admin/console/audit?${new URLSearchParams({ search: term, page: String(page), ...(org !== "all" ? { orgId: org } : {}), ...(from ? { from: siteDayStart(from).toISOString() } : {}), ...(to ? { to: siteDayEnd(to).toISOString() } : {}) })}`,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grow">
          <label
            htmlFor="audit-search"
            className="mb-1.5 block text-xs text-muted-foreground"
          >
            Search activity
          </label>
          <Input
            id="audit-search"
            placeholder="Actor, action or target…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <FilterSelect
          label="Audit client"
          value={org}
          onChange={(v) => {
            setOrg(v);
            setPage(1);
          }}
          options={[
            ["all", "All clients"],
            ...(orgs.data ?? []).map((o) => [o.id, o.name] as [string, string]),
          ]}
        />
        <div>
          <label
            htmlFor="audit-from"
            className="mb-1.5 block text-xs text-muted-foreground"
          >
            From
          </label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label
            htmlFor="audit-to"
            className="mb-1.5 block text-xs text-muted-foreground"
          >
            To
          </label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            min={from}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-red-600">
          End date must be on or after the start date.
        </p>
      )}
      <QueryState query={query}>
        <Panel
          title="Platform audit trail"
          description={`Recorded administrative activity across clients · Times shown in ${timezoneLabel()}`}
        >
          {query.data?.rows.length ? (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor / client</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Outcome</th>
                    <th>
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap text-xs">
                        {formatDateTimeSeconds(r.createdAt)}
                      </td>
                      <td>
                        <p className="text-sm font-medium">
                          {r.actorUsername ?? "System"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {r.clientName ?? "Platform"}
                        </p>
                      </td>
                      <td className="capitalize text-xs">
                        {r.action.replaceAll("_", " ")}
                      </td>
                      <td
                        className="max-w-48 truncate text-xs"
                        title={r.targetLabel ?? ""}
                      >
                        {r.targetLabel ?? "—"}
                      </td>
                      <td>
                        <Status value={r.outcome} />
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelected(r)}
                        >
                          Details
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No audit entries found"
              description="Adjust your filters or check back after an administrative action."
            />
          )}
          <Pager page={page} total={query.data?.total ?? 0} setPage={setPage} />
        </Panel>
      </QueryState>
      {selected && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <DialogContent className="max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Audit entry</DialogTitle>
              <DialogDescription>
                {formatDateTimeSeconds(selected.createdAt)} ·{" "}
                {selected.action.replaceAll("_", " ")}
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              {[
                ["Actor", selected.actorUsername],
                ["Role", selected.actorRole],
                ["Client", selected.clientName ?? "Platform"],
                ["IP address", selected.ipAddress],
                ["Target", selected.targetLabel],
                ["Outcome", selected.outcome],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="mt-1 break-words">{v ?? "—"}</dd>
                </div>
              ))}
            </dl>
            <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs">
              {JSON.stringify(selected.detail ?? {}, null, 2)}
            </pre>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
export function Settings({ onLogout }: { onLogout: () => void }) {
  const user = useAuth();
  const query = useAdminQuery<
    {
      group: string;
      items: { key: string; label: string; value: string; source: string }[];
    }[]
  >("/api/admin/settings");
  const [form, setForm] = useState<FormSpec | null>(null);
  const branding = useAdminQuery<{ platformLogoDataUrl: string | null }>("/api/admin/branding");
  const [brandError, setBrandError] = useState<string | null>(null);
  const saveLogo = async (platformLogoDataUrl: string | null) => {
    setBrandError(null);
    try {
      await apiJson("PATCH", "/api/admin/branding", { platformLogoDataUrl });
      await refreshAdmin();
      await branding.refetch();
    } catch (err: any) {
      setBrandError(err?.message ?? "Could not save platform logo.");
    }
  };
  return (
    <div className="space-y-6">
      <Panel
        title="Your account"
        description="Personal security for your platform administrator account."
      >
        <div className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-blue-50 p-3 text-blue-600">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="font-medium text-sm">{user.username}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {user.email} · Super Admin
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() =>
              setForm({
                title: "Change your password",
                description:
                  "Enter your current password and a new password of at least 12 characters. You will sign in again after the change.",
                submit: "Change password",
                fields: [
                  {
                    name: "currentPassword",
                    label: "Current password",
                    type: "password",
                    required: true,
                  },
                  {
                    name: "newPassword",
                    label: "New password",
                    type: "password",
                    required: true,
                  },
                  {
                    name: "confirmPassword",
                    label: "Confirm new password",
                    type: "password",
                    required: true,
                  },
                ],
                save: async (v) => {
                  if (v.newPassword !== v.confirmPassword)
                    throw new Error("New passwords do not match.");
                  await apiJson("POST", "/api/auth/change-password", {
                    currentPassword: v.currentPassword,
                    newPassword: v.newPassword,
                  });
                  onLogout();
                },
              })
            }
          >
            Change password
          </Button>
        </div>
      </Panel>

      <Panel title="Platform branding" description="Logo used for the platform shell, login experience and generated materials.">
        <QueryState query={branding}>
          <div className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-lg border bg-muted/30">
                {branding.data?.platformLogoDataUrl ? (
                  <img src={branding.data.platformLogoDataUrl} alt="Platform logo preview" className="max-h-14 max-w-14 object-contain" />
                ) : (
                  <ShieldCheck className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium">Platform logo</p>
                <p className="mt-1 text-xs text-muted-foreground">PNG, JPG, SVG or WebP under 1.5 MB.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input type="file" accept="image/*" className="w-64" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try { await saveLogo(await imageToDataUrl(file)); }
                catch (err: any) { setBrandError(err.message); }
              }} />
              {branding.data?.platformLogoDataUrl && <Button variant="outline" onClick={() => void saveLogo(null)}>Remove</Button>}
            </div>
          </div>
          {brandError && <p className="border-t px-6 py-3 text-sm text-red-600">{brandError}</p>}
        </QueryState>
      </Panel>

      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        Platform configuration below is managed by the deployment. These values
        are read-only. Client allowances are editable in Clients → Usage &
        limits.
      </div>
      <QueryState query={query}>
        <div className="grid items-start gap-5 xl:grid-cols-2">
          {query.data?.map((group) => (
            <Panel
              key={group.group}
              title={group.group}
              action={
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Deployment managed
                </span>
              }
            >
              <dl className="divide-y">
                {group.items.map((item) => (
                  <div
                    className="flex flex-wrap justify-between gap-2 px-5 py-4"
                    key={item.key}
                  >
                    <dt className="text-sm text-muted-foreground">
                      {item.label}
                    </dt>
                    <dd className="max-w-full break-all text-sm font-medium">
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>
          ))}
        </div>
      </QueryState>
      {form && <FormDialog spec={form} close={() => setForm(null)} />}
    </div>
  );
}
