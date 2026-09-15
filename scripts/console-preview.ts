// Isolated browser/latency harness. Never starts recorders or touches the public schema.
import "dotenv/config";
import express from "express";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  testPool,
  resetSchema,
  dropSchema,
} from "../server/__tests__/helpers/testDb";
const schema = "test_console_browser";
const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL required");
process.env.DATABASE_URL =
  raw +
  (raw.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${schema}`;
process.env.NODE_ENV = "development";
process.env.SESSION_SECRET = randomBytes(32).toString("hex");
process.env.MTX_API_BASE = "http://127.0.0.1:19997";
process.env.MQTT_URL = "";
process.env.RECORDINGS_BASE = "/tmp/vms-console-preview/recordings";
process.env.LICENSE_KEY_DIR = "/tmp/vms-console-preview/keys";
process.env.LICENSE_PRIVATE_KEY_PATH =
  "/tmp/vms-console-preview/keys/license-signing-private.pem";
process.env.LICENSE_PUBLIC_KEY_PATH =
  "/tmp/vms-console-preview/keys/license-signing-public.pem";
mkdirSync("/tmp/vms-console-preview/recordings", { recursive: true });
const setup = testPool(schema);
await resetSchema(setup, schema);
const { storage, pool } = await import("../server/storage");
const { hashPassword, setupSession } = await import("../server/auth");
const { registerRoutes } = await import("../server/routes");
const { ensureSigningKeys } = await import("../server/licenseCrypto");
const { applySecurityHeaders, requireSameOrigin } = await import(
  "../server/security"
);
ensureSigningKeys();
const base = await storage.upsertProduct({
  key: "vms",
  name: "Video Management",
  active: true,
});
await storage.upsertProduct({
  key: "intrusion",
  name: "Intrusion Detection",
  active: true,
});
const password = `Preview-${randomBytes(12).toString("hex")}!`;
const hash = await hashPassword(password);
let firstOrg = "";
for (let i = 0; i < 28; i++) {
  const name =
    [
      "ABC Security",
      "Northstar Logistics",
      "Meridian Retail",
      "Harbor Industrial",
      "Pioneer Campus",
    ][i] ?? `Regional Client ${String(i + 1).padStart(2, "0")}`;
  const org = await storage.createOrganization({
    name,
    slug: `preview-client-${i}`,
    status: i === 3 ? "suspended" : "active",
  });
  if (i === 0) firstOrg = org.id;
  await storage.createLicense({
    organizationId: org.id,
    productId: base.id,
    plan: i % 2 ? "monthly" : "yearly",
    status: "active",
    expiresAt: i % 3 === 0 ? new Date(Date.now() + 14 * 86400000) : null,
    limits: {
      maxCameras: i === 0 ? 250 : 100,
      maxUsers: 25,
      maxSites: 4,
      maxStorageGb: 1000,
    },
  });
  if (i < 5)
    await setup.query(
      `INSERT INTO cameras (organization_id,channel_id,name,stream_url,stream_type,status,recording_enabled) SELECT $1, 'ch-'||n, 'Fixture camera '||n, 'rtsp://127.0.0.1/fixture', 'rtsp', CASE WHEN n % 30 = 0 THEN 'inactive' ELSE 'active' END, false FROM generate_series(1,$2) n`,
      [org.id, i === 0 ? 218 : 20 + i * 15],
    );
}
const users: Record<string, string> = {};
for (const role of [
  "super_admin",
  "client_admin",
  "client_manager",
  "client_employee",
]) {
  const username = `preview_${role}`;
  const user = await storage.createUser({
    username,
    email: `${role}@preview.local`,
    role,
    status: "active",
    organizationId: role === "super_admin" ? null : firstOrg,
    passwordHash: hash,
  });
  users[role] = username;
}
writeFileSync(
  "/tmp/vms-console-preview/credentials.json",
  JSON.stringify({ password, users, organizationId: firstOrg }),
  { mode: 0o600 },
);
const app = express();
applySecurityHeaders(app);
setupSession(app);
app.use("/api", requireSameOrigin);
app.use(express.json());
const server = await registerRoutes(app, { startBackgroundServices: false });
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(err.status || 500).json({ error: err.message }),
);
app.use(express.static("/tmp/vms-console-preview/public"));
app.get("*", (_req, res) =>
  res.sendFile("/tmp/vms-console-preview/public/index.html"),
);
server.listen(5299, "127.0.0.1", () =>
  console.log("Isolated console preview ready at http://127.0.0.1:5299"),
);
async function close() {
  server.close();
  await pool.end();
  await dropSchema(setup, schema);
  await setup.end();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
