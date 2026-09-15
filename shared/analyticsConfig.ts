// shared/analyticsConfig.ts
//
// The geometry a person-analytics rule needs, described ONCE for both sides.
//
// WHY THIS IS SHARED CODE
//   Zones and lines are typed as free-form config on the binding row, and the
//   worker parses them in Python. If the browser and the server each had their
//   own idea of a valid polygon, a spec that passed the UI could still reach
//   the worker and raise ValueError there — which used to kill the worker and
//   put the supervisor into a restart loop. One definition, used by the form
//   and re-checked by the API, removes that class of bug.
//
// COORDINATE SPACE
//   Whole pixels in the analytics worker's own frame — the same frame served by
//   GET /api/cameras/:id/frame. Not normalised, not display pixels. A polygon
//   drawn against a scaled preview and stored unscaled would sit somewhere
//   else entirely in the frame the rule evaluates, and the client would get
//   alerts for the wrong part of their site.

/** Config keys holding a closed polygon: "x1,y1,x2,y2,x3,y3,..." */
export const POLYGON_KEYS = [
  "INTRUSION_ZONE",
  "LOITER_ZONE",
  "CROWD_ZONE",
  "QUEUE_ZONE",
] as const;

/** Config keys holding a single line segment: "x1,y1,x2,y2" */
export const LINE_KEYS = ["COUNT_LINE", "TAILGATE_LINE"] as const;

export type GeometryKey = (typeof POLYGON_KEYS)[number] | (typeof LINE_KEYS)[number];

export interface FeatureGeometry {
  key: GeometryKey;
  kind: "polygon" | "line";
  /** Without this the rule refuses to start (worker raises RuleNotConfigured). */
  required: boolean;
  label: string;
  help: string;
}

/**
 * What each person-analytics feature needs drawn before it can run.
 *
 * `required: true` mirrors `requires_zone` in models/person/pipeline/rules.py.
 * Getting this wrong in the permissive direction is what produced the intrusion
 * alert storm: a zone rule with no zone treats the WHOLE FRAME as restricted.
 */
export const FEATURE_GEOMETRY: Record<string, FeatureGeometry> = {
  intrusion: {
    key: "INTRUSION_ZONE",
    kind: "polygon",
    required: true,
    label: "Restricted area",
    help:
      "Draw the area nobody should enter. Intrusion will not run until this " +
      "exists — with no area drawn, every person in view is an intruder.",
  },
  loitering: {
    key: "LOITER_ZONE",
    kind: "polygon",
    required: false,
    label: "Loitering area",
    help:
      "Where standing around for too long is worth reporting. Leave empty to " +
      "use the restricted area, or to watch the whole frame.",
  },
  crowd_density: {
    key: "CROWD_ZONE",
    kind: "polygon",
    required: false,
    label: "Crowd area",
    help: "Where crowding is counted. Leave empty to watch the whole frame.",
  },
  queue_dwell: {
    key: "QUEUE_ZONE",
    kind: "polygon",
    required: false,
    label: "Queue area",
    help: "The queue itself — waiting time is measured for people inside it.",
  },
  people_count: {
    key: "COUNT_LINE",
    kind: "line",
    required: false,
    label: "Counting line",
    help:
      "People are counted when they CROSS this line, with direction. Without " +
      "a line only periodic occupancy is reported, not footfall.",
  },
  tailgating: {
    key: "TAILGATE_LINE",
    kind: "line",
    required: false,
    label: "Access line",
    help:
      "Draw across the doorway. Two or more people crossing within a few " +
      "seconds is reported. Falls back to the counting line if left empty.",
  },
};

export type Point = { x: number; y: number };

/** Points -> the stored string. Rounded: sub-pixel precision is meaningless. */
export function formatGeometry(points: Point[]): string {
  return points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(",");
}

/** Several areas -> one stored value. Empty areas are dropped, not stored. */
export function formatAreas(areas: Point[][]): string {
  return areas
    .filter((a) => a.length > 0)
    .map(formatGeometry)
    .join(AREA_SEPARATOR);
}

/** One stored value -> the areas in it. Throws on a malformed area. */
export function parseAreas(spec: string): Point[][] {
  if (!spec || !spec.trim()) return [];
  return spec
    .split(AREA_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(parseGeometry);
}

/**
 * Separator between SEVERAL areas on one camera.
 *
 * A real site rarely has exactly one restricted area in a view — a yard camera
 * covers the fuel store and the transformer bay, and they are not one shape.
 * ";" used to be an alias for "," (so "1,2;3,4" was one polygon); it now
 * separates polygons, which is the only reading that lets a camera carry more
 * than one area.
 */
export const AREA_SEPARATOR = ";";

/** The stored string -> points of ONE area. Returns [] for empty; throws on malformed. */
export function parseGeometry(spec: string): Point[] {
  if (!spec || !spec.trim()) return [];
  const nums = spec
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "")
    .map(Number);
  if (nums.some((n) => !Number.isFinite(n))) {
    throw new Error("contains something that is not a number");
  }
  if (nums.length % 2) throw new Error("has an odd number of coordinates");
  const pts: Point[] = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

/**
 * Validate one geometry value. Returns a message an operator can act on, or
 * null when it is fine. An EMPTY value is always valid here — "not drawn yet"
 * is a legitimate state that the worker handles by not starting that one rule.
 */
export function validateGeometry(key: string, value: unknown): string | null {
  const isPolygon = (POLYGON_KEYS as readonly string[]).includes(key);
  const isLine = (LINE_KEYS as readonly string[]).includes(key);
  if (!isPolygon && !isLine) return null;

  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return `${key} must be a list of coordinates.`;

  let areas: Point[][];
  try {
    // A line is always a single segment; only areas can repeat.
    areas = isLine ? [parseGeometry(value)] : parseAreas(value);
  } catch (err: any) {
    return `${key} ${err.message}.`;
  }
  if (areas.length === 0) return null;

  for (const [i, pts] of areas.entries()) {
    const which = areas.length > 1 ? ` (area ${i + 1})` : "";
    if (pts.length === 0) continue;

    if (isLine && pts.length !== 2) {
      return `${key} is a line and needs exactly 2 points, got ${pts.length}.`;
    }
    if (isPolygon && pts.length < 3) {
      return `${key}${which} is an area and needs at least 3 corners, got ${pts.length}.`;
    }
    // A million-pixel coordinate is a unit mix-up (normalised values scaled
    // wrongly, or a polygon drawn against a different frame size), not a real
    // camera. Caught here because the symptom otherwise is "the zone never
    // fires" with nothing in any log to explain it.
    if (pts.some((p) => p.x < 0 || p.y < 0 || p.x > 20000 || p.y > 20000)) {
      return `${key}${which} has coordinates outside any real frame — it was probably drawn against a different image size.`;
    }
    if (isLine && pts[0].x === pts[1].x && pts[0].y === pts[1].y) {
      return `${key} starts and ends at the same point, so nothing can cross it.`;
    }
  }
  return null;
}

/**
 * Validate a whole binding config — geometry, schedule and tunables.
 *
 * Everything here is re-checked on the server because the browser is not a
 * trust boundary, and because a value that reaches a Python worker malformed
 * used to kill it.
 */
export function validateAnalyticsConfig(
  config: Record<string, unknown> | null | undefined,
  feature?: string
): string[] {
  if (!config) return [];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (k === SCHEDULE_KEY) {
      const m = validateSchedule(v);
      if (m) problems.push(m);
      continue;
    }
    const g = validateGeometry(k, v);
    if (g) {
      problems.push(g);
      continue;
    }
    if (feature) {
      const t = validateTunable(feature, k, v);
      if (t) problems.push(t);
      const toggle = (FEATURE_TOGGLES[feature] ?? []).find((x) => x.key === k);
      if (toggle && !["true", "false", ""].includes(String(v).toLowerCase())) {
        problems.push(`${toggle.label} must be true or false.`);
      }
    }
  }
  return problems;
}

/* ===========================================================================
   WHEN a feature is allowed to raise alerts
   ===========================================================================

   Intrusion on a yard camera is the clearest case: between 07:00 and 19:00 the
   "restricted area" is full of staff doing their jobs, and every one of them is
   an intruder. A client given only "on" or "off" turns the feature off, and the
   site is then unmonitored at night too — the hours that actually mattered.

   A schedule is therefore not a convenience. It is what makes intrusion usable
   on a working site at all.

   Stored as JSON in the binding's config under SCHEDULE_KEY, and passed to the
   worker as one FEATURE_SCHEDULES map so that several features sharing a
   worker cannot collide on the key.
=========================================================================== */

/** Config key holding the schedule. Excluded from the generic env merge. */
export const SCHEDULE_KEY = "SCHEDULE";

/** Monday-first, matching how a rota is written down. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface Schedule {
  /** Weekday indices, 0 = Monday. */
  days: number[];
  /** "HH:MM", 24-hour. */
  from: string;
  to: string;
}

/** Always on — what a feature has when nobody has set a schedule. */
export const ALWAYS: Schedule = {
  days: [0, 1, 2, 3, 4, 5, 6],
  from: "00:00",
  to: "00:00",
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutesOfDay(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`"${hhmm}" is not a time of day (use HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** A 24-hour window is stored as from === to, and means "no time limit". */
export function isAllDay(s: Schedule): boolean {
  return minutesOfDay(s.from) === minutesOfDay(s.to);
}

export function isAlwaysOn(s: Schedule | null | undefined): boolean {
  return !s || (s.days.length === 7 && isAllDay(s));
}

export function parseSchedule(raw: unknown): Schedule | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error("schedule is not readable");
    }
  }
  if (typeof obj !== "object" || obj === null) throw new Error("schedule is not readable");
  const days: number[] = Array.isArray(obj.days) ? obj.days.map(Number) : [];
  if (!days.length) throw new Error("a schedule needs at least one day");
  if (days.some((d: number) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error("schedule days must be 0 (Monday) to 6 (Sunday)");
  }
  minutesOfDay(String(obj.from));
  minutesOfDay(String(obj.to));
  return {
    days: [...new Set<number>(days)].sort((a, b) => a - b),
    from: String(obj.from),
    to: String(obj.to),
  };
}

export function formatSchedule(s: Schedule): string {
  return JSON.stringify({ days: s.days, from: s.from, to: s.to });
}

export function validateSchedule(value: unknown): string | null {
  try {
    parseSchedule(value);
    return null;
  } catch (err: any) {
    return `Schedule: ${err.message}.`;
  }
}

/**
 * The site's own timezone — the one a schedule is written in.
 *
 * NOT the server's clock and NOT the viewer's browser. The server runs in UTC,
 * and a manager checking the site from another country must not see a different
 * answer from the worker that is actually deciding. A schedule belongs to the
 * PLACE the cameras are, so it is evaluated in that place's wall clock.
 *
 * Overridden at runtime from the platform (see setAppTimezone) so this and
 * APP_TIMEZONE in the workers are always the same value.
 */
let APP_TIMEZONE = "Asia/Kolkata";

export function setAppTimezone(tz: string): void {
  if (tz) APP_TIMEZONE = tz;
}
export function getAppTimezone(): string {
  return APP_TIMEZONE;
}

/** Weekday (Mon=0) and minutes-past-midnight for an instant, in the SITE's zone. */
function siteWallClock(at: Date): { day: number; mins: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  // 24:00 is how en-GB renders midnight in some engines; it means 00:00.
  const hour = Number(get("hour")) % 24;
  return { day: day < 0 ? 0 : day, mins: hour * 60 + Number(get("minute")) };
}

/**
 * Is the schedule active at this moment?
 *
 * Kept identical to the Python in the workers so the UI's "active now" badge
 * and the worker's decision can never disagree — a client who is told the
 * feature is armed and gets no alerts has no way to tell which half is lying.
 *
 * A window whose end is not after its start runs THROUGH MIDNIGHT (22:00-06:00
 * is the common intrusion case), and the day it is tested against is the day it
 * STARTED, so a Friday-night watch keeps running into Saturday morning.
 */
export function isScheduleActive(s: Schedule | null | undefined, at: Date = new Date()): boolean {
  if (isAlwaysOn(s)) return true;
  const sch = s!;
  const { day, mins } = siteWallClock(at);
  const from = minutesOfDay(sch.from);
  const to = minutesOfDay(sch.to);

  if (isAllDay(sch)) return sch.days.includes(day);
  if (from < to) return sch.days.includes(day) && mins >= from && mins < to;
  // Overnight: after `from` belongs to today's window; before `to` belongs to
  // the window that started YESTERDAY.
  if (mins >= from) return sch.days.includes(day);
  if (mins < to) return sch.days.includes((day + 6) % 7);
  return false;
}

/** One line an operator can read: "Mon–Fri, 22:00–06:00". */
export function describeSchedule(s: Schedule | null | undefined): string {
  if (isAlwaysOn(s)) return "Always on";
  const sch = s!;
  const time = isAllDay(sch) ? "all day" : `${sch.from}–${sch.to}`;
  const overnight = !isAllDay(sch) && minutesOfDay(sch.from) >= minutesOfDay(sch.to);

  const d = sch.days;
  let days: string;
  if (d.length === 7) days = "Every day";
  else if (d.length === 5 && d.every((x) => x < 5)) days = "Mon–Fri";
  else if (d.length === 2 && d[0] === 5 && d[1] === 6) days = "Weekends";
  else days = d.map((i) => WEEKDAYS[i]).join(", ");

  return `${days}, ${time}${overnight ? " (overnight)" : ""}`;
}

/* ===========================================================================
   Per-feature settings a client can actually reach
   ===========================================================================

   Every threshold used to be a server environment variable. When a client said
   "we get too many unknown-face alerts" or "it fires when someone just clips
   the corner", the only answer was an SSH session — so in practice nothing was
   ever tuned and the client concluded the model was wrong.

   Only settings a site operator can reason about are here. Model confidences
   and NMS thresholds are deliberately absent: exposing a dial nobody can
   interpret produces worse configurations than exposing none.
=========================================================================== */

export interface Tunable {
  key: string;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** The worker's own default, shown when the client has not set anything. */
  fallback: number;
}

export const FEATURE_TUNABLES: Record<string, Tunable[]> = {
  intrusion: [
    {
      key: "INTRUSION_MIN_FRAMES",
      label: "Frames inside before alerting",
      help:
        "How long somebody must be inside the area before it counts. Raise it if " +
        "people walking past the edge trigger alerts; lower it to catch someone " +
        "who crosses quickly.",
      min: 1, max: 30, step: 1, unit: "frames", fallback: 3,
    },
    {
      key: "ALERT_COOLDOWN_S",
      label: "Quiet period after an alert",
      help: "The same person will not raise another alert until this has passed.",
      min: 5, max: 600, step: 5, unit: "seconds", fallback: 60,
    },
  ],
  loitering: [
    {
      key: "LOITER_SECONDS",
      label: "Loitering after",
      help: "How long someone must stay in the area before it is reported.",
      min: 10, max: 1800, step: 10, unit: "seconds", fallback: 60,
    },
  ],
  crowd_density: [
    {
      key: "CROWD_LIMIT",
      label: "Crowd alert above",
      help: "Number of people in the area that counts as crowded.",
      min: 2, max: 200, step: 1, unit: "people", fallback: 10,
    },
  ],
  tailgating: [
    {
      key: "TAILGATE_PEOPLE",
      label: "People through the door",
      help: "How many crossings within the window count as tailgating.",
      min: 2, max: 10, step: 1, unit: "people", fallback: 2,
    },
    {
      key: "TAILGATE_WINDOW_S",
      label: "Within",
      help: "The window the crossings must fall inside.",
      min: 1, max: 30, step: 1, unit: "seconds", fallback: 3,
    },
  ],
  face_recognition: [
    {
      key: "MATCH_THRESHOLD",
      label: "How close a match must be",
      help:
        "Raise it if strangers are being matched to your staff; lower it if your " +
        "own people keep coming up as unknown. Changing this by more than about " +
        "0.05 at a time is rarely right.",
      min: 0.2, max: 0.8, step: 0.01, unit: "similarity", fallback: 0.4,
    },
    {
      key: "MIN_EYE_DISTANCE_PX",
      label: "Smallest face worth identifying",
      help:
        "Measured between the eyes. Below about 40 pixels no model can identify " +
        "a face reliably, so smaller faces are reported without a name rather " +
        "than guessed at.",
      min: 20, max: 200, step: 5, unit: "px", fallback: 40,
    },
    {
      key: "ALERT_COOLDOWN_S",
      label: "Quiet period after an alert",
      help: "The same person will not be announced again until this has passed.",
      min: 5, max: 600, step: 5, unit: "seconds", fallback: 60,
    },
  ],
  fall: [
    {
      key: "FALL_HOLD_S",
      label: "Stay down for",
      help:
        "How long somebody must remain down before it is reported. This is a " +
        "box-shape heuristic, not a medical judgement — verify before dispatching.",
      min: 1, max: 60, step: 1, unit: "seconds", fallback: 2,
    },
  ],
};

/** Config keys that are handled specially and must NOT be merged as env vars. */
export const RESERVED_CONFIG_KEYS = new Set<string>([SCHEDULE_KEY]);

/** Validate one tunable. Returns a message an operator can act on, or null. */
export function validateTunable(feature: string, key: string, value: unknown): string | null {
  const t = (FEATURE_TUNABLES[feature] ?? []).find((x) => x.key === key);
  if (!t) return null;
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${t.label} must be a number.`;
  if (n < t.min || n > t.max) {
    return `${t.label} must be between ${t.min} and ${t.max} ${t.unit}.`;
  }
  return null;
}

/* ===========================================================================
   Yes/no settings a client can reach
   =========================================================================== */

export interface Toggle {
  key: string;
  label: string;
  help: string;
  fallback: boolean;
  /** Shown in amber with the reason, because the choice has a legal dimension. */
  caution?: string;
}

export const FEATURE_TOGGLES: Record<string, Toggle[]> = {
  face_recognition: [
    {
      key: "SAVE_UNKNOWN_SNAPSHOTS",
      label: "Keep a photo when somebody is not recognised",
      // This defaulted to off with no way to change it, which quietly disabled
      // the whole point of an unknown-face alert: the "Who is this?" button had
      // no image to work from, so every unknown row showed "no image" and the
      // client could never name the person who set the alert off.
      help:
        "Without this an unrecognised person raises an alert you cannot act on — " +
        "there is no picture to look at and no way to enrol them from it.",
      caution:
        "A photograph of an unidentified person is the highest-risk record this " +
        "system creates under the DPDP Act 2023. Turn it on only where you have " +
        "a stated reason to keep it, and check your retention period.",
      fallback: false,
    },
    {
      key: "ALERT_ON_UNKNOWN",
      label: "Raise an alert for unrecognised people",
      help:
        "On for a gate or a restricted door. Off where most people are visitors " +
        "and only recognising your own staff matters.",
      fallback: true,
    },
  ],
  intrusion: [
    {
      key: "SAVE_SNAPSHOTS",
      label: "Keep a photo with each alert",
      help:
        "An intrusion alert with no picture forces somebody to go and find the " +
        "footage before they can judge whether it matters.",
      fallback: true,
    },
  ],
};

/** Every settable key for a feature, whichever kind it is. */
export function settableKeys(feature: string): string[] {
  return [
    ...(FEATURE_TUNABLES[feature] ?? []).map((t) => t.key),
    ...(FEATURE_TOGGLES[feature] ?? []).map((t) => t.key),
  ];
}
