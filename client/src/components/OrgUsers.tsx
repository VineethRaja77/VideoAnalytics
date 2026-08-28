import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Users } from "lucide-react";
import { useAuth } from "@/lib/auth";

interface OrgUser { id: string; username: string; email: string; role: string; status: string; }

// Client-admin view: manage the managers and employees in your own org.
export default function OrgUsers() {
  const { toast } = useToast();
  const me = useAuth();
  const [open, setOpen] = useState(false);

  const { data: users = [] } = useQuery<OrgUser[]>({
    queryKey: ["/api/org/users"],
    queryFn: async () => (await apiRequest("GET", "/api/org/users")).json(),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/org/users"] });

  const toggleStatus = useMutation({
    mutationFn: async (u: OrgUser) =>
      apiRequest("PATCH", `/api/org/users/${u.id}`, { status: u.status === "disabled" ? "active" : "disabled" }),
    onSuccess: () => { refresh(); },
    onError: (e: any) => toast({ title: "Failed", description: e?.message?.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2"><Users className="h-5 w-5" /> Team Members</h2>
        <Button onClick={() => setOpen(true)} data-testid="button-add-team-user">
          <Plus className="h-4 w-4 mr-2" /> Add member
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Users in your organization</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between border rounded-md p-3">
              <div>
                <div className="font-medium">{u.email || u.username}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">{u.role.replace("client_", "")}</Badge>
                  {u.status === "disabled" && <span className="text-destructive">disabled</span>}
                  {u.id === me.userId && <span>· you</span>}
                </div>
              </div>
              {u.id !== me.userId && u.role !== "client_admin" && (
                <Button size="sm" variant="outline" onClick={() => toggleStatus.mutate(u)}>
                  {u.status === "disabled" ? "Enable" : "Disable"}
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <AddMemberDialog open={open} onClose={() => setOpen(false)} onDone={refresh} />
    </div>
  );
}

function AddMemberDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("client_employee");

  const save = async () => {
    try {
      await apiRequest("POST", "/api/org/users", { username, email, password, role });
      toast({ title: "Member added" });
      setUsername(""); setEmail(""); setPassword(""); onDone(); onClose();
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message?.replace(/^\d+:\s*/, ""), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add team member</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>Name</Label><Input value={username} onChange={(e) => setUsername(e.target.value)} data-testid="input-member-name" /></div>
          <div className="space-y-1"><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-member-email" /></div>
          <div className="space-y-1"><Label>Password (min 8)</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-member-password" /></div>
          <div className="space-y-1">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger data-testid="select-member-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="client_manager">Manager (can manage cameras)</SelectItem>
                <SelectItem value="client_employee">Employee (view only)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!email || password.length < 8} data-testid="button-save-member">Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
