// "Is anything actually watching?"
//
// A client could enrol fifty people and sit in front of an empty Events tab all
// week, because face recognition was never switched on for any camera. Nothing
// on the page said so. The same is true of intrusion: the events screen and the
// screen that turns the feature on are different screens, and only one of them
// knew the answer.
//
// An empty list has three completely different meanings — nothing is enabled,
// something is enabled but unconfigured, or everything is running and the site
// has simply been quiet. Only the last one is good news, and they look
// identical without this.

import { useQuery } from "@tanstack/react-query";
import { apiRequest, type ApiError } from "@/lib/queryClient";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, Clock, Info } from "lucide-react";
import { FEATURE_LABELS } from "@shared/schema";
import {
  SCHEDULE_KEY,
  describeSchedule,
  isAlwaysOn,
  isScheduleActive,
  parseSchedule,
} from "@shared/analyticsConfig";
import type { CameraLite } from "@/components/ModuleEventsView";

interface Binding {
  id: string;
  cameraId: string;
  feature: string;
  enabled: boolean;
  status: string;
  config: Record<string, string> | null;
  runtime?: { running: boolean };
}

export default function ModuleCoverage({
  features,
  cameras,
  what,
}: {
  /** The licence features this screen reports on. */
  features: readonly string[];
  cameras: CameraLite[];
  /** How to name the thing in a sentence, e.g. "Face recognition". */
  what: string;
}) {
  const { data: bindings = [], isLoading } = useQuery<Binding[], ApiError>({
    queryKey: ["/api/analytics/bindings"],
    queryFn: async () => (await apiRequest("GET", "/api/analytics/bindings")).json(),
    refetchInterval: 30_000,
    retry: false,
  });

  if (isLoading) return null;

  const mine = bindings.filter((b) => features.includes(b.feature) && b.enabled);
  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  if (mine.length === 0) {
    return (
      <Alert variant="destructive" data-testid="coverage-none">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>{what} is not switched on for any camera.</strong> Nothing is being
          watched, so no events can appear here. Turn it on for a camera in{" "}
          <strong>Analytics Setup</strong>.
        </AlertDescription>
      </Alert>
    );
  }

  const waiting = mine.filter((b) => b.status === "needs_config");

  const scheduleOf = (b: Binding) => {
    try {
      return parseSchedule(b.config?.[SCHEDULE_KEY]);
    } catch {
      return null;
    }
  };
  const asleep = mine.filter((b) => {
    const s = scheduleOf(b);
    return s && !isAlwaysOn(s) && !isScheduleActive(s);
  });
  const live = mine.filter((b) => !waiting.includes(b) && !asleep.includes(b));

  return (
    <div className="space-y-2">
      {waiting.length > 0 && (
        <Alert data-testid="coverage-waiting">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>
              {waiting.map((b) => nameOf(b.cameraId)).join(", ")}
            </strong>{" "}
            {waiting.length === 1 ? "is" : "are"} switched on but not yet running —
            still waiting to be configured in Analytics Setup.
          </AlertDescription>
        </Alert>
      )}

      {asleep.length > 0 && (
        <Alert data-testid="coverage-asleep">
          <Clock className="h-4 w-4" />
          <AlertDescription>
            {/* Outside its hours is CORRECT behaviour, not a fault — but a
                client staring at an empty list at 2pm needs to be told it, or
                they will report the feature as broken. */}
            {asleep.map((b) => `${nameOf(b.cameraId)} (${describeSchedule(scheduleOf(b))})`).join(", ")}{" "}
            {asleep.length === 1 ? "is" : "are"} outside their armed hours right now,
            so nothing new will appear from {asleep.length === 1 ? "it" : "them"} until then.
          </AlertDescription>
        </Alert>
      )}

      {live.length > 0 && (
        <Alert data-testid="coverage-live">
          {waiting.length || asleep.length ? (
            <Info className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>Watching now:</span>
            {live.map((b) => (
              <Badge key={b.id} variant="secondary" className="text-xs">
                {nameOf(b.cameraId)}
                {features.length > 1 && ` · ${FEATURE_LABELS[b.feature] ?? b.feature}`}
              </Badge>
            ))}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
