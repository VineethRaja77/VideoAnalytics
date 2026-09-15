// Run against scripts/console-preview.ts only. Uses generated, disposable credentials.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = "http://127.0.0.1:5299";
const credentials = JSON.parse(
  readFileSync("/tmp/vms-console-preview/credentials.json", "utf8"),
);
const output = "/tmp/vms-console-preview/results";
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS", name);
}
async function login(p, role) {
  await p.goto(base);
  await p.getByTestId("input-username").fill(credentials.users[role]);
  await p.getByTestId("input-password").fill(credentials.password);
  await p.getByTestId("button-login").click();
  await p.getByText("Login successful", { exact: true }).waitFor();
  if (role === "super_admin")
    await p
      .getByRole("navigation", { name: "Super Admin", exact: true })
      .waitFor();
  else await p.getByTestId("nav-settings").waitFor();
}
async function nav(name) {
  await page
    .getByRole("navigation", { name: "Super Admin", exact: true })
    .getByRole("link", { name, exact: true })
    .click();
  await page.getByRole("heading", { name, exact: true, level: 1 }).waitFor();
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () => !document.querySelector('main [role="status"]'),
  );
}
try {
  await login(page, "super_admin");
  await check("Eight platform sections, no Fleet", async () => {
    const links = await page
      .getByRole("navigation", { name: "Super Admin", exact: true })
      .getByRole("link")
      .allTextContents();
    assert.deepEqual(links, [
      "Overview",
      "Clients",
      "Licensing",
      "Client Admins",
      "Models",
      "System",
      "Audit",
      "Settings",
    ]);
    await page.getByText("Recently created clients", { exact: true }).waitFor();
    await page.screenshot({
      path: `${output}/overview-desktop.png`,
      fullPage: true,
    });
  });
  await check(
    "Every section loads without runtime/API error states",
    async () => {
      for (const name of [
        "Clients",
        "Licensing",
        "Client Admins",
        "Models",
        "System",
        "Audit",
        "Settings",
        "Overview",
      ]) {
        await nav(name);
        assert.equal(
          await page
            .getByText("Unable to load this section", { exact: true })
            .count(),
          0,
          name,
        );
      }
    },
  );
  await check(
    "Clients have aggregate health, bounded pages and search",
    async () => {
      await nav("Clients");
      assert.equal(await page.locator("tbody tr").count(), 20);
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll("tbody tr").length === 8,
      );
      assert.equal(await page.locator("tbody tr").count(), 8);
      await page
        .getByRole("textbox", { name: "Search clients", exact: true })
        .fill("ABC");
      await page.waitForTimeout(350);
      await page.waitForFunction(
        () => document.querySelectorAll("tbody tr").length === 1,
      );
      assert.equal(await page.locator("tbody tr").count(), 1);
      assert.match(await page.locator("tbody").innerText(), /218 \/ 250/);
      await page.screenshot({
        path: `${output}/clients-desktop.png`,
        fullPage: true,
      });
    },
  );
  await check("Client creation and editable allowances", async () => {
    await page
      .getByRole("button", { name: "Create client", exact: true })
      .click();
    await page
      .getByLabel("Client name", { exact: true })
      .fill("Browser Test Client");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create client", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page
      .getByRole("textbox", { name: "Search clients", exact: true })
      .fill("Browser Test Client");
    await page.waitForTimeout(350);
    await page
      .getByRole("button", { name: "Open Browser Test Client", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit allowances", exact: true })
      .click();
    await page.getByLabel("Cameras", { exact: true }).fill("250");
    await page.getByLabel("Users", { exact: true }).fill("25");
    await page.getByLabel("Sites", { exact: true }).fill("4");
    await page
      .getByLabel("Recording storage (GB)", { exact: true })
      .fill("1000");
    await page
      .getByRole("button", { name: "Save allowances", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.match(await page.locator("main").innerText(), /0 \/ 250/);
  });
  await check(
    "Client administrator creation and password validation",
    async () => {
      await page
        .getByRole("tab", { name: "Administrators", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add administrator", exact: true })
        .click();
      await page.getByLabel("Username", { exact: true }).fill("browser_owner");
      await page
        .getByLabel("Email", { exact: true })
        .fill("browser_owner@preview.local");
      await page.getByLabel("Initial password", { exact: true }).fill("short");
      await page
        .getByRole("button", { name: "Create administrator", exact: true })
        .click();
      await page.getByRole("dialog").getByRole("alert").waitFor();
      await page
        .getByLabel("Initial password", { exact: true })
        .fill("Secure browser owner phrase 456");
      await page
        .getByRole("button", { name: "Create administrator", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByText("browser_owner", { exact: true }).waitFor();
    },
  );
  await check("License grant, edit and signed file download", async () => {
    await page.getByRole("tab", { name: "Licenses", exact: true }).click();
    await page
      .getByRole("button", { name: "Grant license", exact: true })
      .click();
    await page.getByLabel("Module", { exact: true }).selectOption("intrusion");
    await page.getByLabel("Valid until", { exact: true }).fill("2027-12-31");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Grant license", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const row = page
      .locator("tbody tr")
      .filter({ hasText: "Intrusion Detection" });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(
      await page.getByLabel("Valid until", { exact: true }).inputValue(),
      "2027-12-31",
    );
    await page
      .getByRole("button", { name: "Save license", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: /Download/ }).click();
    assert.match((await download).suggestedFilename(), /\.lic$/);
  });
  await check(
    "Suspend requires confirmation and cancel leaves state unchanged",
    async () => {
      await page
        .getByRole("button", { name: "Suspend", exact: true })
        .first()
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Suspend", exact: true })
        .first()
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page
        .getByRole("button", { name: "Reactivate", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Reactivate", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    },
  );
  await check("Audit filters and entry inspection", async () => {
    await nav("Audit");
    await page
      .getByLabel("Search activity", { exact: true })
      .fill("organization_updated");
    await page.waitForTimeout(350);
    await page.waitForLoadState("networkidle");
    assert.ok((await page.locator("tbody tr").count()) > 0);
    await page
      .getByRole("button", { name: "Details", exact: true })
      .first()
      .click();
    await page
      .getByRole("heading", { name: "Audit entry", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
  });
  await check(
    "Settings separate account actions from deployment controls",
    async () => {
      await nav("Settings");
      await page.getByText("Your account", { exact: true }).waitFor();
      assert.ok(
        (await page.getByText("Deployment managed", { exact: true }).count()) >
          0,
      );
      await page
        .getByRole("button", { name: "Change password", exact: true })
        .click();
      await page.getByLabel("Current password", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: `${output}/settings-desktop.png`,
        fullPage: true,
      });
    },
  );
  await check(
    "Responsive mobile navigation and no document overflow",
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "Super Admin", exact: true })
        .getByRole("link", { name: "Overview", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Overview", exact: true, level: 1 })
        .waitFor();
      await page.waitForLoadState("networkidle");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: `${output}/overview-mobile.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await page.keyboard.press("Escape");
      assert.equal(
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
    },
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await check("Query failures show retry, and recover", async () => {
    await page.route("**/api/admin/console/clients?**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated test failure" }),
      }),
    );
    await nav("Clients");
    await page
      .getByRole("button", { name: "Refresh console data", exact: true })
      .click();
    await page
      .getByText("Unable to load this section", { exact: true })
      .waitFor();
    await page.unroute("**/api/admin/console/clients?**");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.locator("tbody tr").first().waitFor();
  });
  for (const role of ["client_admin", "client_manager", "client_employee"])
    await check(
      `${role}: own navigation/settings and platform API denied`,
      async () => {
        const c = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        });
        const p = await c.newPage();
        p.on("pageerror", (error) => errors.push(error.message));
        await login(p, role);
        await p.getByTestId("nav-settings").click();
        await p
          .getByRole("heading", { name: "Settings", exact: true, level: 1 })
          .waitFor();
        assert.equal(
          await p
            .getByRole("navigation", { name: "Super Admin", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await p.getByText("Organization allowances", { exact: true }).count(),
          role === "client_admin" ? 1 : 0,
        );
        assert.equal(
          await p.getByTestId("nav-add-camera").count(),
          role === "client_employee" ? 0 : 1,
        );
        assert.equal(
          (await p.request.get(`${base}/api/admin/console/overview`)).status(),
          403,
        );
        await p.screenshot({
          path: `${output}/${role}-settings.png`,
          fullPage: true,
        });
        await c.close();
      },
    );
  await check("Measured read latency with authenticated requests", async () => {
    const results = {};
    for (const endpoint of [
      "console/overview",
      "console/clients?page=1",
      "console/admins",
      "console/licenses",
      "console/audit",
      "system",
      "settings",
    ]) {
      const samples = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const r = await page.request.get(`${base}/api/admin/${endpoint}`);
        assert.equal(r.status(), 200);
        await r.body();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      results[endpoint] = {
        p50Ms: +samples[10].toFixed(1),
        p95Ms: +samples[18].toFixed(1),
        maxMs: +samples[19].toFixed(1),
      };
    }
    writeFileSync(`${output}/latency.json`, JSON.stringify(results, null, 2));
    console.log("LATENCY", JSON.stringify(results));
  });
  assert.deepEqual(errors, [], "Browser runtime errors");
  writeFileSync(
    `${output}/checks.json`,
    JSON.stringify({ checks, runtimeErrors: errors }, null, 2),
  );
  console.log(`Completed ${checks.length} browser checks.`);
} finally {
  await browser.close();
}
