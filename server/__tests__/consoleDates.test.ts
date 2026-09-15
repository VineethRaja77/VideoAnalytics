import { describe, it, expect } from "vitest";
import { setAppTimezone } from "@shared/analyticsConfig";
import {
  siteDayEnd,
  licenseLastValidInstant,
} from "../../client/src/lib/datetime";
describe("license valid-through dates", () => {
  it.each(["Asia/Kolkata", "America/New_York", "UTC"])(
    "keeps the selected last day in %s",
    (zone) => {
      setAppTimezone(zone);
      const expiry = siteDayEnd("2027-12-31").toISOString();
      const last = licenseLastValidInstant(expiry);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(last);
      expect(parts).toBe("2027-12-31");
      expect(new Date(expiry).getTime() - last.getTime()).toBe(1);
    },
  );
});
