// Client-admin view: the managers and employees in your own organisation.
//
// This is the screen a client runs their own site from, so it has to cover the
// whole lifecycle of a staff account without anyone phoning the supplier:
//
//   add · disable when somebody leaves · re-enable when they come back ·
//   RESET A PASSWORD when somebody is locked out
//
// The reset was the gap that mattered. The API has supported it all along —
// with strength checking and an audit entry — but nothing in the UI called it,
// so a guard who forgot their password could only be fixed by the vendor. On a
// 24/7 site that is a shift with no login.
//
// The minimum password length is taken from ONE constant shared with the
// server's rule. The dialog used to say "min 8" while the server demanded 12,
// so an admin typed a 9-character password, the button stayed enabled, and the
// save failed. The check that decides is the server's; this only has to stop
// misdescribing it.

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, type ApiError } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, KeyRound, Plus, Users } from "lucide-react";
import { useAuth } from "@/lib/auth";

/** Mirrors validatePasswordStrength() in server/auth.ts. */
const MIN_PASSWORD = 12;

interface OrgUser {
  id: string;
  username: string;
  email: string;
  role: string;
  status: string;
}

const ROLE_LABEL: Record<string, string> = {
  client_admin: "admin",
  client_manager: "manager",
  client_employee: "employee",
};

export default function OrgUsers() {
  const { toast } = useToast();
  const me = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [resetting, setResetting] = useState<OrgUser | null>(null);

  const { data: users = [] } = useQuery<OrgUser[]>({
    queryKey: ["/api/org/users"],
    queryFn: async () => (await apiRequest("GET", "/api/org/users")).json(),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/org/users"] });

  const toggleStatus = useMutation({
    mutationFn: async (u: OrgUser) =>
      apiRequest("PATCH", `/api/org/users/${u.id}`, {
        status: u.status === "disabled" ? "active" : "disabled",
      }),
    onSuccess: (_d, u) => {
      refresh();
      toast({
        title:
          u.status === "disabled"
            ? `${u.email || u.username} can sign in again`
            : `${u.email || u.username} can no longer sign in`,
      });
    },
    onError: (e: ApiError) =>
      toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Users className="h-5 w-5" /> Team Members
        </h2>
        <Button
          className="cursor-pointer"
          onClick={() => setAddOpen(true)}
          data-testid="button-add-team-user"
        >
          <Plus className="mr-2 h-4 w-4" /> Add member
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Users in your organization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {users.map((u) => {
            // The server refuses both actions on yourself and on another admin,
            // so offering them would only produce a rejection.
            const actionable = u.id !== me.userId && u.role !== "client_admin";
            return (
              <div
                key={u.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
                data-testid={`user-row-${u.id}`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{u.email || u.username}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="text-xs">
                      {ROLE_LABEL[u.role] ?? u.role}
                    </Badge>
                    {u.status === "disabled" && (
                      <span className="font-medium text-destructive">
                        disabled — cannot sign in
                      </span>
                    )}
                    {u.id === me.userId && <span>· you</span>}
                  </div>
                </div>

                {actionable && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="cursor-pointer"
                      onClick={() => setResetting(u)}
                      data-testid={`button-reset-password-${u.id}`}
                    >
                      <KeyRound className="mr-1 h-4 w-4" />
                      Reset password
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="cursor-pointer"
                      disabled={toggleStatus.isPending}
                      onClick={() => toggleStatus.mutate(u)}
                      data-testid={`button-toggle-${u.id}`}
                    >
                      {u.status === "disabled" ? "Enable" : "Disable"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <AddMemberDialog open={addOpen} onClose={() => setAddOpen(false)} onDone={refresh} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}

/** Shared password field: one description of the rule, in both dialogs. */
function PasswordField({
  id,
  value,
  onChange,
  label = "Password",
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  const short = value.length > 0 && value.length < MIN_PASSWORD;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={id}
      />
      <p className={`text-xs ${short ? "text-destructive" : "text-muted-foreground"}`}>
        At least {MIN_PASSWORD} characters
        {short && ` — ${MIN_PASSWORD - value.length} more to go`}
      </p>
    </div>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
}: {
  user: OrgUser | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: async () =>
      apiRequest("PATCH", `/api/org/users/${user!.id}`, { password }),
    onSuccess: () => {
      toast({
        title: `Password reset for ${user!.email || user!.username}`,
        description: "Give it to them directly and ask them to change it after signing in.",
      });
      setPassword("");
      setError(null);
      onClose();
    },
    // The server explains exactly why a password was refused — too short, too
    // common, contains the username. Repeating that beats "failed".
    onError: (e: ApiError) => setError(e.message),
  });

  return (
    <Dialog
      open={!!user}
      onOpenChange={(o) => {
        if (!o) {
          setPassword("");
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Reset password
          </DialogTitle>
          <DialogDescription>
            Set a new password for <strong>{user?.email || user?.username}</strong>.
            Their old one stops working immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <PasswordField
            id="input-reset-password"
            label="New password"
            value={password}
            onChange={(v) => {
              setPassword(v);
              setError(null);
            }}
          />
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs leading-relaxed">
              This is recorded in the audit trail against your name. Hand the password
              over in person rather than by message, and ask them to change it.
            </AlertDescription>
          </Alert>
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="cursor-pointer" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="cursor-pointer"
            disabled={password.length < MIN_PASSWORD || reset.isPending}
            onClick={() => reset.mutate()}
            data-testid="button-save-reset-password"
          >
            Set password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddMemberDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("client_employee");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setError(null);
    onClose();
  };

  const save = useMutation({
    mutationFn: async () =>
      apiRequest("POST", "/api/org/users", { username, email, password, role }),
    onSuccess: () => {
      toast({ title: `${email} added` });
      setUsername("");
      setEmail("");
      setPassword("");
      setError(null);
      onDone();
      onClose();
    },
    onError: (e: ApiError) => setError(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add team member</DialogTitle>
          <DialogDescription>
            They can sign in immediately with the password you set here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="input-member-name">Name</Label>
            <Input
              id="input-member-name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              data-testid="input-member-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="input-member-email">Email</Label>
            <Input
              id="input-member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="input-member-email"
            />
          </div>
          <PasswordField
            id="input-member-password"
            value={password}
            onChange={(v) => {
              setPassword(v);
              setError(null);
            }}
          />
          <div className="space-y-1">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger data-testid="select-member-role" className="cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="client_manager" className="cursor-pointer">
                  Manager (can manage cameras)
                </SelectItem>
                <SelectItem value="client_employee" className="cursor-pointer">
                  Employee (view only)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" className="cursor-pointer" onClick={close}>
            Cancel
          </Button>
          <Button
            className="cursor-pointer"
            onClick={() => save.mutate()}
            disabled={!email || password.length < MIN_PASSWORD || save.isPending}
            data-testid="button-save-member"
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
