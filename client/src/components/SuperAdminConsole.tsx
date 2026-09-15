import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bell,
  Building2,
  ChevronDown,
  Cpu,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Shield,
  KeyRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/datetime";
import {
  Section,
  Navigate,
  Status,
  Empty,
  QueryState,
  refreshAdmin,
  useAdminQuery,
} from "./admin/common";
import type { SystemData } from "./admin/Insights";
const Clients = lazy(() =>
  import("./admin/Management").then((m) => ({ default: m.Clients })),
);
const Licensing = lazy(() =>
  import("./admin/Management").then((m) => ({ default: m.Licensing })),
);
const Admins = lazy(() =>
  import("./admin/Management").then((m) => ({ default: m.Admins })),
);
const Overview = lazy(() =>
  import("./admin/Insights").then((m) => ({ default: m.Overview })),
);
const Models = lazy(() =>
  import("./admin/Insights").then((m) => ({ default: m.Models })),
);
const System = lazy(() =>
  import("./admin/Insights").then((m) => ({ default: m.System })),
);
const Audit = lazy(() =>
  import("./admin/Insights").then((m) => ({ default: m.Audit })),
);
const Settings = lazy(() =>
  import("./admin/Insights").then((m) => ({ default: m.Settings })),
);

const sections = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    description: "Aggregate organization usage, licensing and platform health.",
  },
  {
    id: "clients",
    label: "Organizations",
    icon: Building2,
    description:
      "Customer accounts with their administrator, modules and limits managed together.",
  },
  {
    id: "licensing",
    label: "Licensing",
    icon: KeyRound,
    description:
      "Manage contracts, renewals and license files across all organizations.",
  },
  {
    id: "models",
    label: "Models",
    icon: Cpu,
    description:
      "Inspect installed analytics models and verify artifact integrity.",
  },
  {
    id: "system",
    label: "System",
    icon: Activity,
    description: "Service health, capacity and runtime diagnostics.",
  },
  {
    id: "audit",
    label: "Audit",
    icon: ShieldCheck,
    description: "Trace administrative activity across the platform.",
  },
  {
    id: "settings",
    label: "Settings",
    icon: SettingsIcon,
    description: "Account security and effective platform configuration.",
  },
] as const;
function readLocation() {
  const [path, query] = window.location.hash
    .replace(/^#\/?admin\/?/, "")
    .split("?");
  return {
    section: sections.some((s) => s.id === path)
      ? (path as Section)
      : ("overview" as Section),
    params: new URLSearchParams(query),
  };
}
interface Notice {
  id: string;
  message: string;
  severity: string;
  createdAt: string;
  organizationId?: string;
}
export default function SuperAdminConsole({
  onLogout,
}: {
  onLogout: () => void;
}) {
  const user = useAuth();
  const [location, setLocation] = useState(readLocation);
  const [mobile, setMobile] = useState(false);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const system = useAdminQuery<SystemData>("/api/admin/system", 30000);
  const notifications = useAdminQuery<Notice[]>(
    "/api/admin/console/notifications",
    30000,
  );
  const seenKey = `vms-platform-notifications:${user.userId}`;
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(seenKey) ?? "";
    } catch {
      return "";
    }
  });
  const unread = (notifications.data ?? []).filter(
    (n) => n.createdAt > seen,
  ).length;
  const section = sections.find((s) => s.id === location.section)!;
  const navigate: Navigate = (target, params = {}) => {
    window.location.hash = `/admin/${target}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`;
    setMobile(false);
  };
  useEffect(() => {
    const onHash = () => {
      setLocation(readLocation());
      setMobile(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [location.section]);
  useEffect(() => {
    if (!mobile) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    navRef.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobile(false);
      if (event.key === "Tab") {
        const nodes = navRef.current?.querySelectorAll<HTMLElement>("button,a");
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", key);
    };
  }, [mobile]);
  const markRead = () => {
    const time = new Date().toISOString();
    setSeen(time);
    try {
      localStorage.setItem(seenKey, time);
    } catch {
      /* private browser */
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshAdmin();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#admin-content"
        onClick={(e) => {
          e.preventDefault();
          heading.current?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded focus:bg-white focus:p-3"
      >
        Skip to content
      </a>
      {mobile && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden"
          onClick={() => setMobile(false)}
          aria-hidden="true"
        />
      )}
      <aside
        ref={navRef}
        aria-label="Platform navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white text-slate-700 shadow-sm ${mobile ? "flex" : "hidden lg:flex"}`}
      >
        <div className="flex h-[76px] shrink-0 items-center gap-3 border-b px-6">
          <span className="rounded-lg border bg-slate-50 p-2 text-slate-900">
            <Shield className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-bold tracking-[0.08em] text-slate-950">
              HYPERSPARK
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Super Admin
            </p>
          </div>
          <button
            className="ml-auto lg:hidden"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="space-y-1 px-3 pt-5" aria-label="Super Admin">
          {sections.map((s, index) => (
            <a
              href={`#/admin/${s.id}`}
              key={s.id}
              onClick={() => setMobile(false)}
              aria-current={location.section === s.id ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${index === 5 ? "!mt-5" : ""} ${location.section === s.id ? "bg-slate-900 text-white shadow-sm" : "hover:bg-slate-100 hover:text-slate-950"}`}
            >
              <s.icon className="h-[18px] w-[18px]" />
              {s.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto border-t p-4">
          <button
            onClick={onLogout}
            className="mt-3 flex w-full items-center gap-3 rounded-md px-3 py-2 text-xs hover:bg-slate-100 hover:text-slate-950"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0 lg:pl-64">
        <header className="sticky top-0 z-30 flex h-[76px] items-center justify-between gap-3 border-b bg-card/95 px-4 backdrop-blur-sm sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              className="lg:hidden"
              variant="ghost"
              size="icon"
              aria-label="Open navigation"
              aria-expanded={mobile}
              onClick={() => setMobile(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <span className="hidden text-xs text-muted-foreground md:block">
              Platform <span className="mx-3 text-border">/</span>
              <span className="font-medium text-foreground">
                {section.label}
              </span>
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <form
              className="relative hidden sm:block"
              onSubmit={(e) => {
                e.preventDefault();
                navigate("clients", { search });
              }}
            >
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Search organizations"
                placeholder="Search organizations..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-44 bg-muted/40 pl-9 text-xs xl:w-64"
              />
            </form>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
                  className="relative"
                >
                  <Bell className="h-[18px] w-[18px]" />
                  {unread > 0 && (
                    <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-[min(24rem,calc(100vw-2rem))] p-0"
              >
                <div className="flex items-center justify-between border-b p-4">
                  <h2 className="text-sm font-semibold">
                    Platform notifications
                  </h2>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!unread}
                    onClick={markRead}
                  >
                    Mark read
                  </Button>
                </div>
                <QueryState query={notifications}>
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.data?.length ? (
                      notifications.data.map((n) => (
                        <button
                          key={n.id}
                          onClick={() =>
                            navigate(
                              n.organizationId ? "clients" : "system",
                              n.organizationId
                                ? { client: n.organizationId }
                                : {},
                            )
                          }
                          className="block w-full border-b p-4 text-left last:border-0 hover:bg-muted/30"
                        >
                          <div className="mb-2 flex items-center justify-between">
                            <Status value={n.severity} />
                            <span className="text-[10px] text-muted-foreground">
                              {formatDateTime(n.createdAt)}
                            </span>
                          </div>
                          <p className="text-xs leading-relaxed">{n.message}</p>
                        </button>
                      ))
                    ) : (
                      <Empty
                        title="No platform notifications"
                        description="Quota and host storage notices appear here."
                      />
                    )}
                  </div>
                </QueryState>
                <p className="border-t p-3 text-[10px] text-muted-foreground">
                  Recent runtime notices. Administrative history is retained in
                  Audit.
                </p>
              </PopoverContent>
            </Popover>
            <div className="mx-1 h-6 w-px bg-border" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-2 rounded-full px-1.5 py-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Account menu"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">
                    {user.username.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="hidden text-left xl:block">
                    <span className="block max-w-32 truncate text-xs font-semibold">
                      {user.username}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      Super Admin
                    </span>
                  </span>
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  {user.email ?? user.username}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("settings")}>
                  <SettingsIcon className="mr-2 h-4 w-4" />
                  Account & settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main id="admin-content" className="mx-auto max-w-[1700px] p-4 sm:p-8">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-600">
                Platform administration
              </p>
              <h1
                ref={heading}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none sm:text-[28px]"
              >
                {section.label}
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {section.description}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => void refresh()}
              aria-label="Refresh console data"
              className="mt-6 shrink-0"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              <span className="ml-2 hidden sm:inline">Refresh</span>
            </Button>
          </div>
          <Suspense
            fallback={
              <div
                role="status"
                className="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground"
              >
                Loading section…
              </div>
            }
          >
            {location.section === "overview" && (
              <Overview navigate={navigate} />
            )}
            {location.section === "clients" && (
              <Clients
                key={`${location.params.get("search") ?? ""}:${location.params.get("client") ?? ""}`}
                navigate={navigate}
                search={location.params.get("search") ?? ""}
                selected={location.params.get("client") ?? undefined}
              />
            )}
            {location.section === "licensing" && <Licensing />}
            {/* Reachable by deep link, but not a sidebar item: administrators
                belong to the organization they administer, so the way in is opening
                that organization. */}
            {location.section === "admins" && <Admins />}
            {location.section === "models" && <Models />}
            {location.section === "system" && <System />}
            {location.section === "audit" && <Audit />}
            {location.section === "settings" && (
              <Settings onLogout={onLogout} />
            )}
          </Suspense>
          <footer className="mt-10 flex flex-wrap justify-between gap-2 border-t pt-4 text-[10px] text-muted-foreground">
            <span>HYPERSPARK · Platform console</span>
            <span>
              {system.data?.host.timezone ?? user.timezone} · Organization data is access controlled
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
