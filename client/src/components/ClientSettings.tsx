import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { ChangePasswordDialog } from "./TopHeader";
import {
  Panel,
  QueryState,
  UsageBar,
  useAdminQuery,
  type Usage,
} from "./admin/common";
function OrganizationUsage() {
  const query = useAdminQuery<Usage[]>("/api/org/usage", 30000);
  return (
    <QueryState query={query}>
      <Panel
        title="Organization allowances"
        description="Your provider manages these limits. Contact them to increase an allowance."
      >
        <div className="grid gap-6 p-6 sm:grid-cols-2">
          {query.data?.map((u) => (
            <UsageBar key={u.key} usage={u} />
          ))}
        </div>
      </Panel>
    </QueryState>
  );
}
export default function ClientSettings() {
  const user = useAuth();
  const [password, setPassword] = useState(false);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account
          {user.role === "client_admin" ? " and organization allowances" : ""}.
        </p>
      </div>
      <Panel title="Account security">
        <div className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <p className="font-medium">{user.username}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {user.email} · {user.role.replaceAll("_", " ")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Site timezone: {user.timezone}
            </p>
          </div>
          <Button variant="outline" onClick={() => setPassword(true)}>
            Change password
          </Button>
        </div>
      </Panel>
      {user.role === "client_admin" && <OrganizationUsage />}
      <ChangePasswordDialog
        open={password}
        onClose={() => setPassword(false)}
      />
    </div>
  );
}
