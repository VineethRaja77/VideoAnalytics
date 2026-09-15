// When a feature is allowed to raise alerts.
//
// This is the control that decides whether a client keeps intrusion switched on
// at all. Between 07:00 and 19:00 a working yard is full of staff, and every one
// of them is inside the "restricted area". Given only on/off, the client turns
// it off — and the site is then unwatched at night too, which was the point.
//
// Two things this deliberately does NOT do:
//   - offer per-day time ranges. A rota that differs by day is real, but the
//     form to express it is four times the size and the common case is one
//     window across chosen days. A second window can be added later without
//     changing what is stored.
//   - hide the overnight case. 22:00–06:00 is the normal intrusion setting and
//     reads like a mistake, so it is spelled out rather than left to be
//     inferred.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Clock } from "lucide-react";
import {
  ALWAYS,
  WEEKDAYS,
  describeSchedule,
  isAlwaysOn,
  isScheduleActive,
  minutesOfDay,
  type Schedule,
} from "@shared/analyticsConfig";

interface Props {
  value: Schedule | null;
  onChange: (next: Schedule | null) => void;
  disabled?: boolean;
}

/** Presets, because most sites want one of these and not a form. */
const PRESETS: { label: string; schedule: Schedule }[] = [
  { label: "Overnight", schedule: { days: [0, 1, 2, 3, 4, 5, 6], from: "19:00", to: "07:00" } },
  { label: "Weekends", schedule: { days: [5, 6], from: "00:00", to: "00:00" } },
  { label: "Working hours", schedule: { days: [0, 1, 2, 3, 4], from: "08:00", to: "18:00" } },
];

export default function ScheduleEditor({ value, onChange, disabled = false }: Props) {
  const limited = !isAlwaysOn(value);
  const s: Schedule = value ?? ALWAYS;
  const activeNow = isScheduleActive(value);

  const set = (patch: Partial<Schedule>) => onChange({ ...s, ...patch });

  const toggleDay = (i: number) => {
    const days = s.days.includes(i) ? s.days.filter((d) => d !== i) : [...s.days, i].sort();
    // Never allow zero days: a schedule with no days can never fire, which
    // looks identical to a broken feature.
    if (!days.length) return;
    set({ days });
  };

  const overnight =
    limited &&
    s.from !== s.to &&
    minutesOfDay(s.from) >= minutesOfDay(s.to);

  return (
    <div className="space-y-3 rounded-md border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <h5 className="text-sm font-semibold">When it is armed</h5>
          {limited ? (
            <Badge
              className={
                activeNow
                  ? "border-transparent bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200"
                  : "border-transparent bg-muted text-muted-foreground"
              }
            >
              {activeNow ? "Armed now" : "Not armed now"}
            </Badge>
          ) : (
            <Badge variant="secondary">Always on</Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Label htmlFor="schedule-limited" className="cursor-pointer text-xs text-muted-foreground">
            Only at certain times
          </Label>
          <Switch
            id="schedule-limited"
            checked={limited}
            disabled={disabled}
            className="cursor-pointer"
            onCheckedChange={(on) =>
              onChange(on ? { days: [0, 1, 2, 3, 4, 5, 6], from: "19:00", to: "07:00" } : null)
            }
            data-testid="switch-schedule-limited"
          />
        </div>
      </div>

      {!limited && (
        <p className="text-xs text-muted-foreground">
          Alerts are raised at any hour, on any day. For a restricted area on a
          site where people work, that usually means an alert for every member of
          staff during the working day.
        </p>
      )}

      {limited && (
        <>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                type="button"
                size="sm"
                variant="outline"
                className="cursor-pointer"
                disabled={disabled}
                onClick={() => onChange(p.schedule)}
                data-testid={`schedule-preset-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div>
            <Label className="text-xs text-muted-foreground">Days</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d, i) => {
                const on = s.days.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={disabled}
                    aria-pressed={on}
                    onClick={() => toggleDay(i)}
                    className={`h-9 w-12 cursor-pointer rounded-md border text-xs font-medium transition-colors ${
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    data-testid={`schedule-day-${i}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="schedule-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input
                id="schedule-from"
                type="time"
                value={s.from}
                disabled={disabled}
                className="w-32 cursor-pointer"
                onChange={(e) => set({ from: e.target.value || "00:00" })}
                data-testid="schedule-from"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="schedule-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input
                id="schedule-to"
                type="time"
                value={s.to}
                disabled={disabled}
                className="w-32 cursor-pointer"
                onChange={(e) => set({ to: e.target.value || "00:00" })}
                data-testid="schedule-to"
              />
            </div>
          </div>

          {overnight && (
            <p className="text-xs text-muted-foreground" data-testid="schedule-overnight-note">
              This window runs <strong>through midnight</strong>. A day you tick is
              the evening the watch starts, so ticking Friday covers Friday night
              into Saturday morning.
            </p>
          )}
          {s.from === s.to && (
            <p className="text-xs text-muted-foreground">
              Same start and end means <strong>all day</strong> on the days you tick.
            </p>
          )}
        </>
      )}

      <p className="text-xs font-medium" data-testid="schedule-summary">
        {describeSchedule(value)}
      </p>
    </div>
  );
}
