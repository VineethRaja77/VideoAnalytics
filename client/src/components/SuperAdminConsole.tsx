import { useState, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Building2, Plus, LogOut, ShieldCheck, Users, Ban, CheckCircle2, KeyRound, Download } from "lucide-react";

interface Org {
  id: string;
  name: string;
  slug: string;
  status: string;
  modules: { key: string; status: string; plan: string; expiresAt: string | null; valid: boolean }[];
}
interface Product { id: string; key: string; name: string; }
interface License { id: string; organizationId: string; productKey: string; plan: string; status: string; expiresAt: string | null; machineFingerprint: string | null; }
interface OrgUser { id: string; username: string; email: string; role: string; status: string; }

function useJson<T>(key: string, url: string, enabled = true) {
  return useQuery<T>({ queryKey: [key, url], queryFn: async () => (await apiRequest("GET", url)).json(), enabled });
}

type Section = "organizations" | "licensing";

export default function SuperAdminConsole({ onLogout }: { onLogout: () => void }) {
  const { toast } = useToast();
  const [section, setSection] = useState<Section>("organizations");
  const [selectedOrg, setSelectedOrg] = useState<Org | null>(null);
  const [newOrgOpen, setNewOrgOpen] = useState(false);

  const orgsQ = useJson<Org[]>("orgs", "/api/admin/organizations");
  const productsQ = useJson<Product[]>("products", "/api/admin/products");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["orgs"] });
    queryClient.invalidateQueries({ queryKey: ["all-licenses"] });
    if (selectedOrg) {
      queryClient.invalidateQueries({ queryKey: ["licenses"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
    }
  };

  const setOrgStatus = async (org: Org, status: string) => {
    await apiRequest("PATCH", `/api/admin/organizations/${org.id}`, { status });
    toast({ title: `Organization ${status === "suspended" ? "suspended" : "activated"}` });
    refresh();
  };

  const navItem = (id: Section, icon: ReactNode, label: string, testid: string) => (
    <button
      onClick={() => setSection(id)}
      data-testid={testid}
      className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-md text-sm font-medium transition-colors ${
        section === id ? "bg-primary/10 text-primary" : "hover:bg-muted text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="h-16 border-b border-border bg-card flex items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">HYPERSPARK</span>
          <Badge variant="secondary" className="ml-2">Super Admin</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={onLogout}>
          <LogOut className="h-4 w-4 mr-2" /> Sign out
        </Button>
      </header>

      <div className="flex">
        {/* Left nav rail */}
        <nav className="w-56 border-r border-border min-h-[calc(100vh-4rem)] p-3 space-y-1">
          {navItem("organizations", <Building2 className="h-4 w-4" />, "Organizations", "nav-organizations")}
          {navItem("licensing", <KeyRound className="h-4 w-4" />, "Licensing", "nav-licensing")}
        </nav>

        {section === "organizations" ? (
          <div className="flex flex-1">
            <aside className="w-72 border-r border-border min-h-[calc(100vh-4rem)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm text-muted-foreground">All organizations</h2>
                <Button size="sm" onClick={() => setNewOrgOpen(true)} data-testid="button-new-org">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {orgsQ.data?.map((org) => (
                <button
                  key={org.id}
                  onClick={() => setSelectedOrg(org)}
                  className={`w-full text-left p-3 rounded-md border transition-colors ${
                    selectedOrg?.id === org.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted"
                  }`}
                  data-testid={`org-${org.slug}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{org.name}</span>
                    {org.status === "suspended" && <Badge variant="destructive" className="text-xs">Suspended</Badge>}
                  </div>
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {org.modules.length === 0 && <span className="text-xs text-muted-foreground">no modules</span>}
                    {org.modules.map((m) => (
                      <Badge key={m.key} variant={m.valid ? "secondary" : "outline"} className="text-xs uppercase">
                        {m.key}{!m.valid && " ✕"}
                      </Badge>
                    ))}
                  </div>
                </button>
              ))}
            </aside>

            <main className="flex-1 p-6">
              {!selectedOrg ? (
                <div className="text-muted-foreground text-center mt-20">
                  Select an organization, or create one to get started.
                </div>
              ) : (
                <OrgDetail org={selectedOrg} products={productsQ.data ?? []} onOrgStatus={setOrgStatus} onChanged={refresh} />
              )}
            </main>
          </div>
        ) : (
          <main className="flex-1 p-6">
            <LicensingView orgs={orgsQ.data ?? []} onChanged={refresh} />
          </main>
        )}
      </div>

      <NewOrgDialog open={newOrgOpen} onClose={() => setNewOrgOpen(false)} onCreated={refresh} />
    </div>
  );
}

// All client licensing contracts across every organization, with quick actions.
function LicensingView({ orgs, onChanged }: { orgs: Org[]; onChanged: () => void }) {
  const { toast } = useToast();
  const licensesQ = useJson<License[]>("all-licenses", "/api/admin/licenses");
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8);

  const patch = async (id: string, body: any) => {
    await apiRequest("PATCH", `/api/admin/licenses/${id}`, body);
    toast({ title: "License updated" });
    onChanged();
  };
  const downloadLic = (id: string) => {
    window.open(`/api/admin/licenses/${id}/file`, "_blank");
  };

  const statusBadge = (s: string) => {
    const variant = s === "active" ? "secondary" : s === "trial" ? "outline" : "destructive";
    return <Badge variant={variant as any} className="text-xs capitalize">{s}</Badge>;
  };

  const rows = licensesQ.data ?? [];

  return (
    <div className="space-y-4 max-w-6xl">
      <h1 className="text-2xl font-bold flex items-center gap-2"><KeyRound className="h-6 w-6" /> Licensing Contracts</h1>
      <p className="text-sm text-muted-foreground">
        Every client's module licenses. Suspend or expire to disable a module immediately; download the signed
        <code className="mx-1">.lic</code> file to install on a client's on-prem machine.
      </p>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">Client</th>
                <th className="p-3">Module</th>
                <th className="p-3">Plan</th>
                <th className="p-3">Status</th>
                <th className="p-3">Expires</th>
                <th className="p-3">Machine</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No licenses issued yet.</td></tr>
              )}
              {rows.map((l) => (
                <tr key={l.id} className="border-b last:border-0" data-testid={`license-row-${l.id}`}>
                  <td className="p-3 font-medium">{orgName(l.organizationId)}</td>
                  <td className="p-3 uppercase">{l.productKey}</td>
                  <td className="p-3 capitalize">{l.plan}</td>
                  <td className="p-3">{statusBadge(l.status)}</td>
                  <td className="p-3">{l.expiresAt ? new Date(l.expiresAt).toLocaleDateString() : "—"}</td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {l.machineFingerprint ? l.machineFingerprint.slice(0, 12) + "…" : "not locked"}
                  </td>
                  <td className="p-3">
                    <div className="flex gap-2 justify-end">
                      {l.status === "active" || l.status === "trial" ? (
                        <Button size="sm" variant="outline" onClick={() => patch(l.id, { status: "suspended" })}>Suspend</Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => patch(l.id, { status: "active", expiresAt: null })}>Activate</Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => downloadLic(l.id)} title="Download signed .lic">
                        <Download className="h-4 w-4" />
                      </Button>
                    </div>
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

function OrgDetail({
  org,
  products,
  onOrgStatus,
  onChanged,
}: {
  org: Org;
  products: Product[];
  onOrgStatus: (org: Org, status: string) => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const licensesQ = useJson<License[]>("licenses", `/api/admin/licenses?orgId=${org.id}`);
  const usersQ = useJson<OrgUser[]>("users", `/api/admin/users?orgId=${org.id}`);
  const [grantOpen, setGrantOpen] = useState(false);
  const [newUserOpen, setNewUserOpen] = useState(false);

  const patchLicense = async (id: string, body: any) => {
    await apiRequest("PATCH", `/api/admin/licenses/${id}`, body);
    toast({ title: "License updated" });
    onChanged();
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{org.name}</h1>
          <p className="text-sm text-muted-foreground">/{org.slug}</p>
        </div>
        {org.status === "suspended" ? (
          <Button variant="outline" onClick={() => onOrgStatus(org, "active")}>
            <CheckCircle2 className="h-4 w-4 mr-2" /> Reactivate org
          </Button>
        ) : (
          <Button variant="outline" onClick={() => onOrgStatus(org, "suspended")}>
            <Ban className="h-4 w-4 mr-2" /> Suspend org
          </Button>
        )}
      </div>

      {/* Modules & licensing */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Modules & Licensing</CardTitle>
          <Button size="sm" onClick={() => setGrantOpen(true)} data-testid="button-grant-license">
            <Plus className="h-4 w-4 mr-1" /> Grant module
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {licensesQ.data?.length === 0 && <p className="text-sm text-muted-foreground">No modules licensed yet.</p>}
          {licensesQ.data?.map((l) => (
            <div key={l.id} className="flex items-center justify-between border rounded-md p-3">
              <div>
                <div className="font-medium uppercase">{l.productKey}</div>
                <div className="text-xs text-muted-foreground">
                  {l.plan} · {l.status}
                  {l.expiresAt ? ` · expires ${new Date(l.expiresAt).toLocaleDateString()}` : " · no expiry"}
                </div>
              </div>
              <div className="flex gap-2">
                {l.status === "suspended" || l.status === "expired" ? (
                  <Button size="sm" variant="outline" onClick={() => patchLicense(l.id, { status: "active", expiresAt: null })}>
                    Activate
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => patchLicense(l.id, { status: "suspended" })}>
                    Suspend
                  </Button>
                )}
                <Select onValueChange={(v) => patchLicense(l.id, { plan: v })} value={l.plan}>
                  <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trial">Trial</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                    <SelectItem value="perpetual">Perpetual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Users */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" /> Users</CardTitle>
          <Button size="sm" onClick={() => setNewUserOpen(true)} data-testid="button-new-user">
            <Plus className="h-4 w-4 mr-1" /> Add user
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {usersQ.data?.length === 0 && <p className="text-sm text-muted-foreground">No users yet.</p>}
          {usersQ.data?.map((u) => (
            <div key={u.id} className="flex items-center justify-between border rounded-md p-3">
              <div>
                <div className="font-medium">{u.email || u.username}</div>
                <div className="text-xs text-muted-foreground">{u.role}{u.status === "disabled" && " · disabled"}</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await apiRequest("PATCH", `/api/admin/users/${u.id}`, { status: u.status === "disabled" ? "active" : "disabled" });
                  onChanged();
                }}
              >
                {u.status === "disabled" ? "Enable" : "Disable"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <GrantLicenseDialog org={org} products={products} open={grantOpen} onClose={() => setGrantOpen(false)} onDone={onChanged} />
      <NewUserDialog org={org} open={newUserOpen} onClose={() => setNewUserOpen(false)} onDone={onChanged} />
    </div>
  );
}

function NewOrgDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const save = async () => {
    try {
      await apiRequest("POST", "/api/admin/organizations", { name, slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") });
      toast({ title: "Organization created" });
      setName(""); setSlug(""); onCreated(); onClose();
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message?.replace(/^\d+:\s*/, ""), variant: "destructive" });
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New Organization</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-org-name" /></div>
          <div className="space-y-1"><Label>Slug (optional)</Label><Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto from name" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!name} data-testid="button-save-org">Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GrantLicenseDialog({ org, products, open, onClose, onDone }: { org: Org; products: Product[]; open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [productKey, setProductKey] = useState("vms");
  const [plan, setPlan] = useState("trial");
  const [expiresAt, setExpiresAt] = useState("");
  const [machineFingerprint, setMachineFingerprint] = useState("");
  const save = async () => {
    try {
      await apiRequest("POST", "/api/admin/licenses", {
        organizationId: org.id, productKey, plan, status: "active",
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        machineFingerprint: machineFingerprint.trim() || null,
      });
      toast({ title: "Module granted" });
      setMachineFingerprint(""); onDone(); onClose();
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message?.replace(/^\d+:\s*/, ""), variant: "destructive" });
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Grant module to {org.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Module</Label>
            <Select value={productKey} onValueChange={setProductKey}>
              <SelectTrigger data-testid="select-product"><SelectValue /></SelectTrigger>
              <SelectContent>{products.map((p) => <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Plan</Label>
            <Select value={plan} onValueChange={setPlan}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
                <SelectItem value="perpetual">Perpetual</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label>Expiry (optional)</Label><Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>
          <div className="space-y-1">
            <Label>Machine fingerprint (on-prem only)</Label>
            <Input
              value={machineFingerprint}
              onChange={(e) => setMachineFingerprint(e.target.value)}
              placeholder="leave blank for cloud / not machine-locked"
              data-testid="input-machine-fingerprint"
            />
            <p className="text-xs text-muted-foreground">
              Get it from the client's box: <code>GET /api/license/fingerprint</code>. Binds the signed license to that machine.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} data-testid="button-save-license">Grant</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewUserDialog({ org, open, onClose, onDone }: { org: Org; open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("client_admin");
  const save = async () => {
    try {
      await apiRequest("POST", "/api/admin/users", { username, email, password, organizationId: org.id, role });
      toast({ title: "User created" });
      setUsername(""); setEmail(""); setPassword(""); onDone(); onClose();
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message?.replace(/^\d+:\s*/, ""), variant: "destructive" });
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add user to {org.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>Name</Label><Input value={username} onChange={(e) => setUsername(e.target.value)} data-testid="input-user-name" /></div>
          <div className="space-y-1"><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-user-email" /></div>
          <div className="space-y-1"><Label>Password (min 8)</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-user-password" /></div>
          <div className="space-y-1">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger data-testid="select-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="client_admin">Client Admin</SelectItem>
                <SelectItem value="client_manager">Client Manager</SelectItem>
                <SelectItem value="client_employee">Client Employee (read-only)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!email || password.length < 8} data-testid="button-save-user">Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
