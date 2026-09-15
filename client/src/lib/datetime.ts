// Every time the client shows, rendered in the SITE's timezone.
//
// WHY NOT toLocaleString()
//   The browser's default renders in the VIEWER's timezone. A manager checking
//   an Indian site from another country would see different times from the
//   guard standing next to the camera, from the worker that raised the alert,
//   and from the CSV they export — with nothing on screen saying which was
//   which. An event belongs to the place it happened, so it is shown in that
//   place's clock for everyone.
//
// WHY A ZONE NAME AND NOT AN OFFSET
//   Nothing here adds or subtracts hours. The IANA database does the work, so a
//   zone whose rules change is handled by a tzdata update rather than by us.
//   (India is a fixed +5:30 with no daylight saving, but the same code is
//   correct for a site that isn't.)

import { getAppTimezone } from "@shared/analyticsConfig";

function parts(d: Date, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: getAppTimezone(),
      ...opts,
    }).format(d);
  } catch {
    // An unknown zone name must not blank out every timestamp on the page.
    return new Intl.DateTimeFormat("en-GB", opts).format(d);
  }
}

const valid = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "13 Sep 2026, 01:23" — date and time, for event rows. */
export function formatDateTime(v: string | Date | null | undefined): string {
  const d = valid(v);
  if (!d) return "—";
  return parts(d, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "13 Sep 2026" — for dates where the time adds nothing. */
export function formatDate(v: string | Date | null | undefined): string {
  const d = valid(v);
  if (!d) return "—";
  return parts(d, { day: "2-digit", month: "short", year: "numeric" });
}

/** With seconds — for an audit trail, where ordering within a minute matters. */
export function formatDateTimeSeconds(v: string | Date | null | undefined): string {
  const d = valid(v);
  if (!d) return "—";
  return parts(d, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * The short zone label ("IST"), so a reader never has to guess whose clock a
 * timestamp is on. Shown once per table rather than on every row.
 */
export function timezoneLabel(): string {
  // en-GB renders Asia/Kolkata as "GMT+5:30"; the abbreviation an Indian
  // client actually recognises is "IST", and en-IN is the locale that knows
  // it. Falling back to en-GB keeps a sensible label for any other zone.
  for (const locale of ["en-IN", "en-GB"]) {
    try {
      const p = new Intl.DateTimeFormat(locale, {
        timeZone: getAppTimezone(),
        timeZoneName: "short",
      }).formatToParts(new Date());
      const v = p.find((x) => x.type === "timeZoneName")?.value;
      // Skip a bare numeric offset if a real abbreviation is available.
      if (v && !/^GMT[+-]/.test(v)) return v;
    } catch {
      /* unknown zone — try the next locale */
    }
  }
  return getAppTimezone();
}

/**
 * How far the site's zone is from UTC at a given instant, in milliseconds.
 *
 * Derived from the IANA database via Intl, never hardcoded — so a zone with
 * daylight saving gives a different answer in June than in December, and this
 * keeps working. (India does not, but the code should not assume that.)
 */
function offsetMs(at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: getAppTimezone(),
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value])
  ) as Record<string, string>;
  const asIfUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return asIfUtc - at.getTime();
}

/**
 * The instant at which a calendar date BEGINS at the site.
 *
 * A date picker gives "2026-09-13", and `new Date("2026-09-13")` reads that as
 * midnight UTC — which at an Indian site is 05:30 on the 13th. Filtering
 * "events on the 13th" that way silently drops the first five and a half hours
 * of the day and picks up the tail of the 12th. The operator is looking at the
 * wrong day and nothing on screen says so.
 *
 * `dayOffset` of 1 gives the start of the NEXT day, which is how an inclusive
 * "to" date is expressed as an exclusive upper bound.
 */
export function siteDayStart(dateStr: string, dayOffset = 0): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return new Date(NaN);
  const guess = new Date(Date.UTC(y, m - 1, d + dayOffset, 0, 0, 0));
  // One correction is enough: the offset at the guess and at the true instant
  // differ only if a DST change falls inside that window, and then only by the
  // shift itself — which cannot move the result across another boundary.
  return new Date(guess.getTime() - offsetMs(guess));
}

/** The instant a calendar date ENDS at the site (exclusive). */
export function siteDayEnd(dateStr: string): Date {
  return siteDayStart(dateStr, 1);
}

/**
 * "2026-09-13-10-44-51" — a sortable stamp in SITE time, for filenames.
 *
 * A downloaded snapshot named in UTC does not match the event list the operator
 * is comparing it against, which is the moment they stop trusting either.
 */
export function fileStamp(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: getAppTimezone(), hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  ) as Record<string, string>;
  return `${p.year}-${p.month}-${p.day}-${String(Number(p.hour) % 24).padStart(2, "0")}-${p.minute}-${p.second}`;
}

/** Licenses expire at an exclusive instant. Midnight belongs to the following
 * day, so display/edit the last covered instant rather than extending the term
 * by a day every time the form is saved. */
export function licenseLastValidInstant(expiresAt: string): Date {
  return new Date(new Date(expiresAt).getTime() - 1);
}
