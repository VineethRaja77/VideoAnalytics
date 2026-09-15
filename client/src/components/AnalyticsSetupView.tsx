// Analytics Setup — turn AI features on for a camera, and draw what they watch.
//
// This is the screen that was missing. Every analytic in the product was
// bindable only through the API: a client could be licensed for intrusion, have
// the model installed and the worker ready, and still have no way to switch it
// on or tell it which area is restricted.
//
// THE ONE RULE THIS SCREEN EXISTS TO ENFORCE
//   Intrusion with no restricted area drawn means EVERY PERSON IN VIEW is an
//   intruder. The worker refuses to start that rule (RuleNotConfigured), which
//   is right, but silent — the client would see a feature marked "on" producing
//   nothing. So the state is shown here as plainly as it can be: the feature is
//   listed as "waiting for a zone", not as running, until the zone exists.
//
// WHAT IS DELIBERATELY NOT HERE
//   Thresholds (dwell seconds, crowd limits, fall sensitivity). They have
//   defensible defaults, and a settings page dense enough to expose all of them
//   is one nobody reads. Geometry has no sensible default, which is exactly why
//   it is the thing that must be asked for.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, ApiError } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { FEATURE_LABELS, FEATURE_MODULE, MODULE_FEATURES } from "@shared/schema";
import {
  FEATURE_GEOMETRY,
  SCHEDULE_KEY,
  describeSchedule,
  formatSchedule,
  isAlwaysOn,
  isScheduleActive,
  parseSchedule,
  validateGeometry,
  type Schedule,
} from "@shared/analyticsConfig";
import ScheduleEditor from "@/components/ScheduleEditor";
import FeatureSettings, { hasSettings } from "@/components/FeatureSettings";
import { useAuth, canWrite, hasModule } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import ZoneEditor from "@/components/ZoneEditor";
import type { CameraLite } from "@/components/ModuleEventsView";

interface Binding {
  id: string;
  cameraId: string;
  feature: string;
  module: string;
  enabled: boolean;
  config: Record<string, string> | null;
  status: string;
  lastError: string | null;
  runtime?: { running: boolean; pid: number | null; restartCount: number };
}

const MODULE_LABELS: Record<string, string> = {
  person: "People & intrusion",
  face: "Face recognition",
  vehicle: "Vehicles & traffic",
  ppe: "PPE compliance",
  tamper: "Camera tampering",
  object: "Objects left or removed",
};

/** Modules that run on a camera. Sensors have no camera and no video. */
const CAMERA_MODULES = Object.keys(MODULE_FEATURES).filter((m) => m !== "sensors");

/** Parse a stored schedule without letting a bad one break the row. */
function parseScheduleQuietly(raw: unknown): Schedule | null {
  try {
    return parseSchedule(raw);
  } catch {
    return null;
  }
}

/**
 * Drop keys the operator cleared.
 *
 * Storing "" for a setting is not the same as leaving it unset: an empty string
 * reaches the worker as an empty environment variable, and a worker reading
 * float("") crashes. Absent means "use the default", which is what clearing a
 * field is meant to do.
 */
function stripEmpty(cfg: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cfg).filter(([, v]) => v !== "" && v !== null && v !== undefined)
  );
}

export default function AnalyticsSetupView({ cameras }: { cameras: CameraLite[] }) {
  const auth = useAuth();
  const writable = canWrite(auth.role);
  const { toast } = useToast();

  const [cameraId, setCameraId] = useState<string>(cameras[0]?.id ?? "");
  const [open, setOpen] = useState<string | null>(null);
  /** Unsaved config per feature — geometry, schedule and settings together.
   *  Nothing is applied until Save: a half-drawn polygon or a half-typed
   *  threshold reaching the worker would restart it for nothing. */
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    if (!cameraId && cameras.length) setCameraId(cameras[0].id);
  }, [cameras, cameraId]);

  const { data: bindings = [], isLoading } = useQuery<Binding[], ApiError>({
    queryKey: ["/api/cameras", cameraId, "analytics"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/cameras/${cameraId}/analytics`)).json(),
    enabled: !!cameraId,
    refetchInterval: 15_000,
  });

  const byFeature = useMemo(
    () => new Map(bindings.map((b) => [b.feature, b])),
    [bindings]
  );

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["/api/cameras", cameraId, "analytics"] });

  const save = useMutation({
    mutationFn: async (vars: {
      feature: string;
      enabled?: boolean;
      config?: Record<string, string> | null;
    }) => {
      const existing = byFeature.get(vars.feature);
      if (existing) {
        return (
          await apiRequest("PATCH", `/api/analytics/bindings/${existing.id}`, {
            ...(vars.enabled !== undefined ? { enabled: vars.enabled } : {}),
            ...(vars.config !== undefined ? { config: vars.config } : {}),
          })
        ).json();
      }
      return (
        await apiRequest("POST", `/api/cameras/${cameraId}/analytics`, {
          feature: vars.feature,
          enabled: vars.enabled ?? true,
          config: vars.config ?? null,
        })
      ).json();
    },
    onSuccess: (_d, vars) => {
      refresh();
      toast({ title: `${FEATURE_LABELS[vars.feature] ?? vars.feature} updated` });
    },
    onError: (err: ApiError) =>
      toast({
        title: "Could not save",
        // The server explains exactly what was wrong with the geometry or why
        // the licence was refused. Repeating that beats a generic failure.
        description: err.message,
        variant: "destructive",
      }),
  });

  // Only features this client is actually licensed for. The server enforces
  // this again on every write; hiding them here just avoids offering something
  // that would be refused.
  const licensedByModule = CAMERA_MODULES.map((mod) => ({
    module: mod,
    features: (MODULE_FEATURES as Record<string, readonly string[]>)[mod].filter((f) =>
      hasModule(auth, f)
    ),
  })).filter((m) => m.features.length > 0);

  if (!cameras.length) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Add a camera first — analytics run on a camera's stream.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <SlidersHorizontal className="h-5 w-5 text-primary" />
            Analytics Setup
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose what each camera watches for, and draw the areas it applies to.
          </p>
        </div>

        <div className="w-full space-y-1.5 sm:w-72">
          <Label htmlFor="camera-select">Camera</Label>
          <Select
            value={cameraId}
            onValueChange={(v) => {
              setCameraId(v);
              setOpen(null);
              setDraft({});
            }}
          >
            <SelectTrigger id="camera-select" className="cursor-pointer" data-testid="select-camera">
              <SelectValue placeholder="Select a camera" />
            </SelectTrigger>
            <SelectContent>
              {cameras.map((c) => (
                <SelectItem key={c.id} value={c.id} className="cursor-pointer">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {licensedByModule.length === 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            No camera analytics are licensed for this organisation yet.
          </AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
          Reading this camera's settings…
        </p>
      )}

      {licensedByModule.map(({ module, features }) => (
        <Card key={module}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{MODULE_LABELS[module] ?? module}</CardTitle>
            {/* Worth saying once per module: it explains why enabling a second
                feature costs almost nothing, and why saving one restarts the
                others on that camera. */}
            <p className="text-xs text-muted-foreground">
              These features share one detector on this camera, so enabling several
              costs little more than enabling one.
            </p>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {features.map((feature) => {
              const binding = byFeature.get(feature);
              const geo = FEATURE_GEOMETRY[feature];
              const saved = (binding?.config ?? {}) as Record<string, string>;
              // Saved config with any unsaved edits laid over it.
              const cfg = { ...saved, ...(draft[feature] ?? {}) };

              const savedValue = saved[geo?.key ?? ""] ?? "";
              const current = cfg[geo?.key ?? ""] ?? "";
              const geoError = geo ? validateGeometry(geo.key, current) : null;
              const missingRequired = !!geo?.required && !savedValue;

              let schedule: Schedule | null = null;
              try {
                schedule = parseSchedule(cfg[SCHEDULE_KEY]);
              } catch {
                schedule = null;
              }
              const savedSchedule = saved[SCHEDULE_KEY] ?? "";

              const dirty = Object.keys(draft[feature] ?? {}).some(
                (k) => (draft[feature]![k] ?? "") !== (saved[k] ?? "")
              );
              // Expandable when there is anything to configure at all, not just
              // geometry — face recognition has no zone but plenty to set.
              const expandable = !!geo || hasSettings(feature);
              const isOpen = open === feature;

              const setDraftKey = (k: string, v: string) =>
                setDraft((d) => ({ ...d, [feature]: { ...(d[feature] ?? {}), [k]: v } }));
              const clearDraft = () =>
                setDraft((d) => {
                  const n = { ...d };
                  delete n[feature];
                  return n;
                });

              return (
                <div key={feature} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {expandable ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 shrink-0 cursor-pointer p-0"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Hide" : "Show"} settings for ${
                            FEATURE_LABELS[feature] ?? feature
                          }`}
                          onClick={() => setOpen(isOpen ? null : feature)}
                          data-testid={`toggle-geometry-${feature}`}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      ) : (
                        <span className="h-7 w-7 shrink-0" />
                      )}

                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {FEATURE_LABELS[feature] ?? feature}
                        </p>
                        <StatusLine
                          binding={binding}
                          missingRequired={missingRequired}
                          geoLabel={geo?.label}
                          schedule={
                            savedSchedule ? parseScheduleQuietly(savedSchedule) : null
                          }
                        />
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={!!binding?.enabled}
                        disabled={!writable || save.isPending}
                        className="cursor-pointer"
                        aria-label={`Enable ${FEATURE_LABELS[feature] ?? feature} on this camera`}
                        onCheckedChange={(on) =>
                          save.mutate({ feature, enabled: on })
                        }
                        data-testid={`switch-${feature}`}
                      />
                    </div>
                  </div>

                  {isOpen && expandable && (
                    <div className="mt-4 space-y-4 rounded-md border bg-muted/30 p-4">
                      {geo && (
                        <ZoneEditor
                          cameraId={cameraId}
                          configKey={geo.key}
                          kind={geo.kind}
                          label={geo.label}
                          help={geo.help}
                          value={current}
                          disabled={!writable}
                          onChange={(spec) => setDraftKey(geo.key, spec)}
                        />
                      )}

                      {/* The control that decides whether a client keeps this
                          feature switched on. See ScheduleEditor. */}
                      <ScheduleEditor
                        value={schedule}
                        disabled={!writable}
                        onChange={(next) =>
                          setDraftKey(SCHEDULE_KEY, next ? formatSchedule(next) : "")
                        }
                      />

                      <FeatureSettings
                        feature={feature}
                        config={cfg}
                        disabled={!writable}
                        onChange={setDraftKey}
                      />

                      {writable && (
                        <div className="flex flex-wrap items-center gap-3">
                          <Button
                            size="sm"
                            className="cursor-pointer"
                            disabled={!dirty || !!geoError || save.isPending}
                            onClick={() =>
                              save.mutate(
                                {
                                  feature,
                                  // Merge, never replace: another feature's
                                  // geometry lives in the same config object
                                  // and overwriting it would silently erase a
                                  // zone somebody else drew.
                                  config: stripEmpty({ ...saved, ...(draft[feature] ?? {}) }),
                                },
                                { onSuccess: clearDraft }
                              )
                            }
                            data-testid={`save-geometry-${feature}`}
                          >
                            {save.isPending ? (
                              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                            ) : (
                              <Save className="mr-1 h-4 w-4" />
                            )}
                            Save changes
                          </Button>
                          {dirty && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="cursor-pointer"
                                onClick={clearDraft}
                                data-testid={`discard-${feature}`}
                              >
                                Discard
                              </Button>
                              <span className="text-xs text-muted-foreground">
                                Saving restarts this camera's detector — about five
                                seconds without analytics.
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * One line of truth per feature.
 *
 * "Enabled" and "actually running" are different things, and conflating them is
 * how a client ends up believing a camera is watched when it is not. A feature
 * that is on but waiting for a zone, or on but crashed, says so here.
 */
function StatusLine({
  binding,
  missingRequired,
  geoLabel,
  schedule,
}: {
  binding?: Binding;
  missingRequired: boolean;
  geoLabel?: string;
  schedule?: Schedule | null;
}) {
  if (!binding || !binding.enabled) {
    return <p className="text-xs text-muted-foreground">Off</p>;
  }

  // A scheduled feature that is outside its window is NOT broken and not
  // running-with-a-problem: it is doing exactly what it was told. Saying
  // "Running" would be a lie, and saying nothing would look like a fault.
  const scheduleNote =
    schedule && !isAlwaysOn(schedule) ? (
      <span className="text-muted-foreground">
        {" "}
        · {describeSchedule(schedule)}
      </span>
    ) : null;

  if (schedule && !isAlwaysOn(schedule) && !isScheduleActive(schedule)) {
    return (
      <p className="text-xs text-muted-foreground">
        On, outside its hours{scheduleNote}
      </p>
    );
  }
  if (missingRequired || binding.status === "needs_config") {
    // Amber, not red. Nothing is broken: the client bought the feature, the
    // model is installed and the worker is healthy — an operator simply has not
    // finished the setup. Showing this as an error would send them looking for
    // a fault that does not exist.
    return (
      <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
        Waiting for {geoLabel?.toLowerCase() ?? "configuration"} — not running yet
      </p>
    );
  }
  if (binding.status === "unlicensed") {
    return (
      <p className="text-xs text-destructive">
        Not licensed — this feature has been stopped
      </p>
    );
  }
  if (binding.lastError) {
    return (
      <p className="truncate text-xs text-destructive" title={binding.lastError}>
        {binding.lastError}
      </p>
    );
  }
  if (binding.runtime?.running || binding.status === "running") {
    return (
      <p className="text-xs text-green-600 dark:text-green-500">
        Running
        {binding.runtime && binding.runtime.restartCount > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · restarted {binding.runtime.restartCount}x
          </span>
        )}
        {scheduleNote}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      <Badge variant="outline" className="mr-1 text-[10px]">
        {binding.status}
      </Badge>
      starting up
    </p>
  );
}
