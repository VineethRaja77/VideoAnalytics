// The dials a site operator can actually reach.
//
// Every threshold used to be a server environment variable. When a client said
// "we get too many unknown-face alerts" or "it fires when someone just clips the
// corner of the area", the only answer was an SSH session — so in practice
// nothing was ever tuned and the client concluded the model was wrong.
//
// Only settings somebody running a site can reason about appear here. Model
// confidences and NMS thresholds are deliberately absent: a dial nobody can
// interpret produces worse configurations than no dial at all.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ShieldAlert } from "lucide-react";
import { FEATURE_TOGGLES, FEATURE_TUNABLES } from "@shared/analyticsConfig";

interface Props {
  feature: string;
  config: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}

export function hasSettings(feature: string): boolean {
  return (
    (FEATURE_TUNABLES[feature]?.length ?? 0) > 0 ||
    (FEATURE_TOGGLES[feature]?.length ?? 0) > 0
  );
}

export default function FeatureSettings({ feature, config, onChange, disabled }: Props) {
  const tunables = FEATURE_TUNABLES[feature] ?? [];
  const toggles = FEATURE_TOGGLES[feature] ?? [];
  if (!tunables.length && !toggles.length) return null;

  return (
    <div className="space-y-4 rounded-md border bg-background p-4">
      <h5 className="text-sm font-semibold">Settings</h5>

      {toggles.map((t) => {
        const raw = config[t.key];
        const on = raw === undefined || raw === "" ? t.fallback : String(raw) === "true";
        return (
          <div key={t.key} className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor={`toggle-${t.key}`} className="cursor-pointer text-sm">
                  {t.label}
                </Label>
                <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{t.help}</p>
              </div>
              <Switch
                id={`toggle-${t.key}`}
                checked={on}
                disabled={disabled}
                className="mt-0.5 shrink-0 cursor-pointer"
                onCheckedChange={(v) => onChange(t.key, String(v))}
                data-testid={`setting-${t.key}`}
              />
            </div>
            {/* Shown only when the risky option is actually chosen — a warning
                that is always on stops being read. */}
            {t.caution && on && (
              <Alert>
                <ShieldAlert className="h-4 w-4" />
                <AlertDescription className="text-xs leading-relaxed">
                  {t.caution}
                </AlertDescription>
              </Alert>
            )}
          </div>
        );
      })}

      {tunables.map((t) => {
        const raw = config[t.key];
        const value = raw === undefined || raw === "" ? String(t.fallback) : String(raw);
        const n = Number(value);
        const bad = !Number.isFinite(n) || n < t.min || n > t.max;
        const isDefault = raw === undefined || raw === "";
        return (
          <div key={t.key} className="space-y-1">
            <Label htmlFor={`tune-${t.key}`} className="text-sm">
              {t.label}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={`tune-${t.key}`}
                type="number"
                inputMode="decimal"
                min={t.min}
                max={t.max}
                step={t.step}
                value={value}
                disabled={disabled}
                className="w-32"
                onChange={(e) => onChange(t.key, e.target.value)}
                data-testid={`setting-${t.key}`}
              />
              <span className="text-xs text-muted-foreground">{t.unit}</span>
              {isDefault && (
                <span className="text-xs text-muted-foreground">· default</span>
              )}
            </div>
            <p className="max-w-prose text-xs text-muted-foreground">{t.help}</p>
            {bad && (
              <p className="text-xs text-destructive" role="alert">
                Must be between {t.min} and {t.max} {t.unit}.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
