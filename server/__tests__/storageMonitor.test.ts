// The disk-full scenario is the one that takes a whole site down at once, and
// the one with the worst diagnostics: recording, analytics and Postgres all
// fail together with errors that never mention the disk. The monitor exists to
// tell the client admin BEFORE that happens, so these tests pin the behaviour
// that makes the warning useful — thresholds, one alert per transition, and a
// message that names the cause and the fix.

import "dotenv/config";

import { describe, it, expect, afterEach, vi } from "vitest";

const ORG = "org-any";

/**
 * Thresholds are read at module load, so each test loads the monitor fresh with
 * its own env. resetModules also gives that copy a fresh `events` module, so the
 * event log must be read from the SAME reload — importing `../events` at the top
 * of this file would observe a different instance and see nothing.
 */
async function loadMonitor(env: Record<string, string>) {
  vi.resetModules();
  Object.assign(process.env, env);
  const [monitor, events] = await Promise.all([
    import("../storageMonitor"),
    import("../events"),
  ]);
  events.clearEvents();
  return { ...monitor, listEvents: events.listEvents, clearEvents: events.clearEvents };
}
afterEach(() => vi.restoreAllMocks());

describe("disk thresholds", () => {
  it("reads real free space and classifies it", async () => {
    const { checkDisk } = await loadMonitor({});
    const st = await checkDisk(process.cwd());
    expect(st.totalGB).toBeGreaterThan(0);
    expect(st.freeGB).toBeGreaterThanOrEqual(0);
    expect(st.usedPercent).toBeGreaterThan(0);
    expect(["ok", "warning", "critical"]).toContain(st.level);
  });

  it("falls back to an existing parent when the target does not exist yet", async () => {
    // On a fresh install the recordings folder is created on first camera add;
    // the monitor must still report, not throw.
    const { checkDisk } = await loadMonitor({});
    const st = await checkDisk(process.cwd() + "/no/such/dir/at/all");
    expect(st.totalGB).toBeGreaterThan(0);
  });

  it("treats a low ABSOLUTE free space as critical even at a low percentage", async () => {
    // 5% used of a 40 TB array still leaves plenty; 5% used of a small volume
    // does not. A percentage alone is the wrong alarm on large disks, so the
    // GB floor has to be able to fire on its own.
    const { checkDisk } = await loadMonitor({
      STORAGE_MIN_FREE_GB: "999999",
      STORAGE_WARN_PERCENT: "99",
      STORAGE_CRITICAL_PERCENT: "99",
    });
    const st = await checkDisk(process.cwd());
    expect(st.level).toBe("critical");
  });

  it("is ok when both thresholds are far away", async () => {
    const { checkDisk } = await loadMonitor({
      STORAGE_MIN_FREE_GB: "0",
      STORAGE_WARN_PERCENT: "100",
      STORAGE_CRITICAL_PERCENT: "100",
    });
    expect((await checkDisk(process.cwd())).level).toBe("ok");
  });
});

describe("admin notification", () => {
  it("notifies the admin when the disk crosses into critical", async () => {
    const { runCheck, resetLevelForTest, listEvents } = await loadMonitor({
      STORAGE_MIN_FREE_GB: "999999",
      STORAGE_WARN_PERCENT: "1",
      STORAGE_CRITICAL_PERCENT: "1",
    });
    resetLevelForTest();

    await runCheck();

    const ev = listEvents(ORG).find((e) => e.type === "storage_critical");
    expect(ev).toBeDefined();
    expect(ev!.severity).toBe("critical");
  });

  it("says what is wrong, how bad, and what to do — not a generic error", async () => {
    // "Storage problem" is useless to a client admin at 2am. The message must
    // carry the number, the path and the remedy.
    const { runCheck, resetLevelForTest, listEvents } = await loadMonitor({
      STORAGE_MIN_FREE_GB: "999999",
      STORAGE_WARN_PERCENT: "1",
      STORAGE_CRITICAL_PERCENT: "1",
    });
    resetLevelForTest();
    await runCheck();

    const msg = listEvents(ORG).find((e) => e.type === "storage_critical")!.message;
    expect(msg).toMatch(/\d+(\.\d+)?% full/);      // how bad
    expect(msg).toMatch(/GB free/);                 // how much headroom
    expect(msg).toMatch(/Delete old recordings|add storage/i); // what to do
  });

  it("alerts once per transition, not on every check", async () => {
    // At a 5-minute interval, re-alerting would put ~288 identical criticals a
    // day in the bell. Operators stop reading a bell that does that.
    const { runCheck, resetLevelForTest, listEvents } = await loadMonitor({
      STORAGE_MIN_FREE_GB: "999999",
      STORAGE_WARN_PERCENT: "1",
      STORAGE_CRITICAL_PERCENT: "1",
    });
    resetLevelForTest();

    await runCheck();
    await runCheck();
    await runCheck();

    expect(listEvents(ORG).filter((e) => e.type === "storage_critical")).toHaveLength(1);
  });

  it("is visible to every tenant, because the disk is shared", async () => {
    // Disk pressure is emitted with no camera, so it is a platform-wide notice.
    // Every client admin on this box is affected and must see it.
    const { runCheck, resetLevelForTest, listEvents } = await loadMonitor({
      STORAGE_MIN_FREE_GB: "999999",
      STORAGE_WARN_PERCENT: "1",
      STORAGE_CRITICAL_PERCENT: "1",
    });
    resetLevelForTest();
    await runCheck();

    expect(listEvents("org-a").some((e) => e.type === "storage_critical")).toBe(true);
    expect(listEvents("org-b").some((e) => e.type === "storage_critical")).toBe(true);
  });

  it("stays silent while the disk is healthy", async () => {
    const { runCheck, resetLevelForTest, listEvents } = await loadMonitor({
      STORAGE_MIN_FREE_GB: "0",
      STORAGE_WARN_PERCENT: "100",
      STORAGE_CRITICAL_PERCENT: "100",
    });
    resetLevelForTest();
    await runCheck();
    expect(listEvents(ORG)).toHaveLength(0);
  });
});
