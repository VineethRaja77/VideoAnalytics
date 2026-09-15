import { useEffect, useState, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiJson, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  Search,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export type Section =
  | "overview"
  | "clients"
  | "licensing"
  | "admins"
  | "models"
  | "system"
  | "audit"
  | "settings";
export type Navigate = (
  section: Section,
  params?: Record<string, string>,
) => void;
export interface Usage {
  key: string;
  label: string;
  used: number;
  limit: number | null;
  unit: string;
  fraction: number | null;
  level: string;
}
export interface Client {
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  administratorName?: string | null;
  administratorEmail?: string | null;
  plan?: string | null;
  expiresAt?: string | null;
  health: { online: number; offline: number; unknown: number };
  usage: Usage[];
}
export interface Page<T> {
  rows: T[];
  total: number;
}
export interface Org {
  id: string;
  name: string;
  status: string;
  logoDataUrl?: string | null;
}
export interface License {
  id: string;
  organizationId: string;
  clientName: string;
  productKey: string;
  productName: string;
  plan: string;
  status: string;
  storedStatus: string;
  expiresAt: string | null;
  machineFingerprint: string | null;
}
export interface Admin {
  id: string;
  username: string;
  email: string;
  status: string;
  clientName: string;
  organizationId: string;
  createdAt: string;
}
export const number = (n: number) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(n);
export function useAdminQuery<T>(
  url: string,
  interval: number | false = false,
) {
  return useQuery<T>({
    queryKey: ["admin-console", url],
    queryFn: () => apiJson<T>("GET", url),
    staleTime: 15000,
    refetchInterval: (q) =>
      (q.state.data as { checking?: boolean } | undefined)?.checking
        ? 1000
        : interval,
    refetchIntervalInBackground: false,
  });
}
export function useDebounce(value: string) {
  const [v, set] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => set(value), 250);
    return () => clearTimeout(id);
  }, [value]);
  return v;
}
export function refreshAdmin() {
  return queryClient.invalidateQueries({ queryKey: ["admin-console"] });
}
export function Status({ value }: { value: string }) {
  const green = ["active", "healthy", "verified", "ok", "success"].includes(
    value,
  );
  const red = [
    "down",
    "disabled",
    "expired",
    "exceeded",
    "failed",
    "denied",
    "error",
  ].includes(value);
  const amber = [
    "warning",
    "critical",
    "degraded",
    "suspended",
    "unverified",
    "trial",
  ].includes(value);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize whitespace-nowrap ${green ? "border-emerald-200 bg-emerald-50 text-emerald-800" : red ? "border-red-200 bg-red-50 text-red-700" : amber ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-50 text-slate-600"}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {value.replaceAll("_", " ")}
    </span>
  );
}
export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="font-semibold text-sm">{title}</h2>
          {description && (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function QueryState({
  query,
  children,
}: {
  query: Pick<UseQueryResult, "isPending" | "isError" | "error" | "refetch">;
  children: ReactNode;
}) {
  if (query.isPending)
    return (
      <div role="status" className="space-y-4 rounded-xl border bg-card p-6">
        <span className="sr-only">Loading data</span>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded bg-muted motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  if (query.isError)
    return (
      <div
        role="alert"
        className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800"
      >
        <AlertCircle className="mb-2 h-5 w-5" />
        <p className="font-medium">Unable to load this section</p>
        <p className="my-2 text-sm">{query.error?.message}</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  return <>{children}</>;
}
export function Empty({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="px-6 py-14 text-center">
      <Search className="mx-auto mb-3 h-7 w-7 text-slate-300" />
      <p className="font-medium text-sm">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
export function Pager({
  page,
  total,
  setPage,
}: {
  page: number;
  total: number;
  setPage: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / 20));
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages, setPage]);
  return (
    <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-muted-foreground">
      <span>
        {number(total)} results · Page {page} of {pages}
      </span>
      <div className="flex gap-2">
        <Button
          size="icon"
          variant="outline"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="outline"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
export function UsageBar({ usage }: { usage: Usage }) {
  const colour = ["critical", "exceeded"].includes(usage.level)
    ? "bg-red-500"
    : usage.level === "warning"
      ? "bg-amber-500"
      : "bg-blue-500";
  return (
    <div className="min-w-32">
      <div className="mb-1.5 flex justify-between gap-4 text-xs">
        <span>{usage.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {number(usage.used)} /{" "}
          {usage.limit === null ? "Unlimited" : number(usage.limit)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${usage.label} usage`}
        aria-valuenow={usage.used}
        aria-valuemin={0}
        aria-valuemax={usage.limit ?? undefined}
        aria-valuetext={`${number(usage.used)} of ${usage.limit ?? "unlimited"}`}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full ${colour}`}
          style={{
            width: `${usage.fraction === null ? 0 : Math.min(100, usage.fraction * 100)}%`,
          }}
        />
      </div>
    </div>
  );
}
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 max-w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}
export interface Field {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: [string, string][];
  hint?: string;
  min?: number;
  step?: string;
  /** Render `options` as a checkbox grid; the value is a comma-separated list.
   *  Granting modules one at a time on a separate screen is what made
   *  onboarding feel unfinished. */
  multi?: boolean;
  /** Heading above this field, to group a long form into readable sections. */
  section?: string;
}
export interface FormSpec {
  title: string;
  description: string;
  fields: Field[];
  initial?: Record<string, string>;
  submit: string;
  save: (values: Record<string, string>) => Promise<unknown>;
}
export function FormDialog({
  spec,
  close,
}: {
  spec: FormSpec;
  close: () => void;
}) {
  const [values, setValues] = useState(spec.initial ?? {});
  const [visiblePasswords, setVisiblePasswords] = useState<Record<string, boolean>>({});
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: () => spec.save(values),
    onSuccess: async () => {
      await refreshAdmin();
      toast({ title: "Changes saved" });
      close();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) close();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{spec.title}</DialogTitle>
          <DialogDescription>{spec.description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="space-y-4"
        >
          {spec.fields.map((f) => (
            <div className="space-y-1.5" key={f.name}>
              {f.section && (
                <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {f.section}
                </p>
              )}
              <Label htmlFor={`field-${f.name}`}>{f.label}</Label>
              {f.multi && f.options ? (
                <div
                  role="group"
                  aria-label={f.label}
                  className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2"
                >
                  {f.options.map(([v, l]) => {
                    const picked = (values[f.name] ?? "").split(",").filter(Boolean);
                    const on = picked.includes(v);
                    return (
                      <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                        <input
                          type="checkbox"
                          className="cursor-pointer"
                          checked={on}
                          onChange={() =>
                            setValues({
                              ...values,
                              [f.name]: (on ? picked.filter((x) => x !== v) : [...picked, v]).join(","),
                            })
                          }
                          data-testid={`opt-${f.name}-${v}`}
                        />
                        <span>{l}</span>
                      </label>
                    );
                  })}
                </div>
              ) : f.options ? (
                <select
                  id={`field-${f.name}`}
                  required={f.required}
                  value={values[f.name] ?? ""}
                  onChange={(e) =>
                    setValues({ ...values, [f.name]: e.target.value })
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="" disabled>
                    Select {f.label.toLowerCase()}
                  </option>
                  {f.options.map(([v, l]) => (
                    <option value={v} key={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="relative">
                  <Input
                    id={`field-${f.name}`}
                    type={f.type === "password" && visiblePasswords[f.name] ? "text" : f.type ?? "text"}
                    required={f.required}
                    min={f.min}
                    step={f.step}
                    autoComplete={f.type === "password" ? "new-password" : "off"}
                    value={values[f.name] ?? ""}
                    className={f.type === "password" ? "pr-10" : undefined}
                    onChange={(e) =>
                      setValues({ ...values, [f.name]: e.target.value })
                    }
                  />
                  {f.type === "password" && (
                    <button
                      type="button"
                      className="absolute right-3 top-2.5 text-muted-foreground"
                      onClick={() => setVisiblePasswords((v) => ({ ...v, [f.name]: !v[f.name] }))}
                      aria-label={visiblePasswords[f.name] ? "Hide password" : "Show password"}
                    >
                      {visiblePasswords[f.name] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  )}
                </div>
              )}
              {f.hint && (
                <p className="text-xs text-muted-foreground">{f.hint}</p>
              )}
            </div>
          ))}
          {mutation.isError && (
            <p role="alert" className="text-sm text-red-600">
              {mutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={close}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {spec.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function ConfirmDialog({
  title,
  description,
  action,
  close,
}: {
  title: string;
  description: string;
  action: () => Promise<unknown>;
  close: () => void;
}) {
  return (
    <FormDialog
      close={close}
      spec={{ title, description, fields: [], submit: "Confirm", save: action }}
    />
  );
}
export const tableClass =
  "w-full text-left text-sm [&_th]:px-5 [&_th]:py-3 [&_th]:font-medium [&_th]:text-xs [&_th]:text-muted-foreground [&_thead]:bg-muted/40 [&_td]:px-5 [&_td]:py-4 [&_tbody_tr]:border-t [&_tbody_tr:hover]:bg-muted/30";
