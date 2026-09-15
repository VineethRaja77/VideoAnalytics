import os from "os";
import path from "path";
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./storage";
import { cameraAnalytics, platformSettings } from "@shared/schema";
import { healthCheck as mediamtxHealthy } from "./mediamtxController";
import { checkDisk } from "./storageMonitor";
import { modelSnapshot } from "./modelRegistry";
import { getAppTimezoneName } from "./timezone";

export type ServiceState = "healthy" | "degraded" | "down" | "unknown";
export interface ServiceReport {
  key: string;
  label: string;
  state: ServiceState;
  detail: string;
  latencyMs?: number;
}
let cached: { services: ServiceReport[]; checkedAt: string } | undefined;
let pending: Promise<void> | undefined;
async function check(
  key: string,
  label: string,
  fn: () => Promise<Omit<ServiceReport, "key" | "label">>,
): Promise<ServiceReport> {
  const start = performance.now();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Check timed out")), 2500);
      }),
    ]);
    return {
      key,
      label,
      ...value,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch {
    return {
      key,
      label,
      state: "unknown",
      detail: "Check unavailable or timed out. Check the service logs.",
      latencyMs: Math.round(performance.now() - start),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function refreshSystem() {
  if (pending || (cached && Date.now() - Date.parse(cached.checkedAt) < 15000))
    return;
  pending = Promise.all([
    check("database", "Database", async () => {
      const t = performance.now();
      await db.execute(sql`select 1`);
      return {
        state: performance.now() - t > 500 ? "degraded" : "healthy",
        detail: "PostgreSQL connection verified.",
      };
    }),
    check("mediamtx", "Media server", async () => {
      const ok = await mediamtxHealthy();
      return {
        state: ok ? "healthy" : "down",
        detail: ok
          ? "MediaMTX is responding."
          : "MediaMTX is not responding. Check live streaming and recorder connectivity.",
      };
    }),
    check("analytics", "Analytics runtime", async () => {
      const result = await db.execute(
        sql`select count(*) filter (where enabled)::int as enabled, count(*) filter (where enabled and status = 'running' and last_heartbeat_at > now() - interval '2 minutes')::int as running from ${cameraAnalytics}`,
      );
      const row = result.rows[0] as { enabled: number; running: number };
      return {
        state: row.enabled === row.running ? "healthy" : "degraded",
        detail: row.enabled
          ? `${row.running} of ${row.enabled} enabled workers have a recent heartbeat.`
          : "No analytics workers enabled.",
      };
    }),
    check("storage", "Recording storage", async () => {
      const disk = await checkDisk();
      return {
        state: disk.level === "ok" ? "healthy" : "degraded",
        detail: `${disk.usedPercent}% used · ${disk.freeGB} GB free. ${disk.level === "critical" ? "Critical disk pressure. Free space or add capacity." : ""}`,
      };
    }),
  ])
    .then((services) => {
      cached = { services, checkedAt: new Date().toISOString() };
    })
    .finally(() => {
      pending = undefined;
    });
}
export function registerSystemRoutes(app: Express): void {
  app.get("/api/admin/system", (_req, res) => {
    refreshSystem();
    const models = modelSnapshot();
    const unverified = models.modules.filter((m) =>
      m.artifacts.some((a) => a.present && a.matches === undefined),
    );
    const failed = models.modules.filter((m) => !m.ok);
    const services: ServiceReport[] = [
      ...(cached?.services ??
        [
          ["database", "Database"],
          ["mediamtx", "Media server"],
          ["analytics", "Analytics runtime"],
          ["storage", "Recording storage"],
        ].map(([key, label]) => ({
          key,
          label,
          state: "unknown" as const,
          detail: "Initial check in progress.",
        }))),
      {
        key: "models",
        label: "Model artifacts",
        state: !models.checkedAt
          ? "unknown"
          : failed.length
            ? "degraded"
            : unverified.length
              ? "unknown"
              : "healthy",
        detail: !models.checkedAt
          ? "Verification in progress."
          : failed.length
            ? `${failed.length} modules have missing files or checksum failures.`
            : unverified.length
              ? `${unverified.length} modules present without a trusted checksum manifest.`
              : "All required artifacts verified.",
      },
    ];
    const state = !cached
      ? "unknown"
      : services.some((s) => s.state === "down")
        ? "down"
        : services.some((s) => s.state === "degraded")
          ? "degraded"
          : services.some((s) => s.state === "unknown")
            ? "unknown"
            : "healthy";
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      state,
      services,
      checkedAt: cached?.checkedAt ?? null,
      checking: !!pending,
      host: {
        processUptimeSeconds: Math.round(process.uptime()),
        hostUptimeSeconds: Math.round(os.uptime()),
        nodeVersion: process.version,
        platform: `${os.type()} ${os.release()}`,
        cpus: os.cpus().length,
        loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
        memoryTotalGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
        memoryFreeGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
        timezone: getAppTimezoneName(),
        deploymentMode: process.env.DEPLOYMENT_MODE || "cloud",
        environment: process.env.NODE_ENV || "development",
      },
    });
  });
  app.get("/api/admin/console-models", (_req, res) =>
    res.json(modelSnapshot()),
  );

  app.get("/api/admin/branding", async (_req, res) => {
    const rows = await db.select().from(platformSettings);
    const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ platformLogoDataUrl: values.platformLogoDataUrl ?? null });
  });

  app.patch("/api/admin/branding", async (req, res) => {
    const value = typeof req.body?.platformLogoDataUrl === "string" ? req.body.platformLogoDataUrl : req.body?.platformLogoDataUrl === null ? null : undefined;
    if (value === undefined || (value && value.length > 1_500_000)) {
      return res.status(400).json({ error: "Upload a valid logo image under 1.5 MB." });
    }
    await db.execute(sql`
      INSERT INTO ${platformSettings} (key, value, updated_at)
      VALUES ('platformLogoDataUrl', ${value}, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
    `);
    res.json({ platformLogoDataUrl: value });
  });

  /**
   * Effective platform configuration, READ ONLY.
   *
   * Deliberately not editable from the browser. These come from the service's
   * environment, and a settings screen that appeared to save them would either
   * be lying or would need to rewrite a file the running process has already
   * read — which takes effect at a restart nobody asked for. Showing the
   * effective value and where it came from is the honest version, and it is
   * what an operator actually needs when a client reports odd behaviour.
   */
  app.get("/api/admin/settings", async (_req, res) => {
    const show = (v: string | undefined, fallback: string) => v || fallback;
    res.json([
      {
        group: "General",
        items: [
          {
            key: "APP_TIMEZONE",
            label: "Site timezone",
            value: getAppTimezoneName(),
            source: "environment",
          },
          {
            key: "NODE_ENV",
            label: "Environment",
            value: show(process.env.NODE_ENV, "development"),
            source: "environment",
          },
          {
            key: "DEPLOYMENT_MODE",
            label: "Deployment mode",
            value: show(process.env.DEPLOYMENT_MODE, "cloud"),
            source: "environment",
          },
        ],
      },
      {
        group: "Security",
        items: [
          {
            key: "SESSION_IDLE_DAYS",
            label: "Signed in for (idle)",
            value: show(process.env.SESSION_IDLE_DAYS, "30") + " days",
            source: "environment",
          },
          {
            key: "SESSION_ABSOLUTE_DAYS",
            label: "Re-login forced after",
            value: show(process.env.SESSION_ABSOLUTE_DAYS, "90") + " days",
            source: "environment",
          },
          {
            key: "PASSWORD_MIN",
            label: "Minimum password length",
            value: "12 characters",
            source: "code",
          },
          {
            key: "ALLOWED_ORIGINS",
            label: "Allowed origins",
            value: show(process.env.ALLOWED_ORIGINS, "(same host only)"),
            source: "environment",
          },
        ],
      },
      {
        group: "Storage & retention",
        items: [
          {
            key: "RECORDINGS_BASE",
            label: "Recordings path",
            value: show(
              process.env.RECORDINGS_BASE,
              path.join(process.cwd(), "dev_recordings", "recordings"),
            ),
            source: "environment",
          },
          {
            key: "STORAGE_WARN_PERCENT",
            label: "Disk warning at",
            value: show(process.env.STORAGE_WARN_PERCENT, "85") + "%",
            source: "environment",
          },
          {
            key: "STORAGE_CRITICAL_PERCENT",
            label: "Disk critical at",
            value: show(process.env.STORAGE_CRITICAL_PERCENT, "93") + "%",
            source: "environment",
          },
          {
            key: "SNAPSHOT_RETENTION_DAYS",
            label: "Snapshot retention",
            value: show(process.env.SNAPSHOT_RETENTION_DAYS, "30") + " days",
            source: "environment",
          },
        ],
      },
      {
        group: "Client allowances",
        items: [
          {
            key: "LIMIT_WARN_FRACTION",
            label: "Warn a client at",
            value:
              Math.round(Number(process.env.LIMIT_WARN_FRACTION || 0.8) * 100) +
              "% of allowance",
            source: "environment",
          },
          {
            key: "LIMIT_CRITICAL_FRACTION",
            label: "Critical at",
            value:
              Math.round(
                Number(process.env.LIMIT_CRITICAL_FRACTION || 0.95) * 100,
              ) + "% of allowance",
            source: "environment",
          },
        ],
      },
    ]);
  });
}
