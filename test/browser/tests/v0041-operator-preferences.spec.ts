import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivors of the api-gateway operator-preference E2E cases (v0041 D15):
// the Web UI half against a mocked Gateway. Session, identity and durable
// storage halves are Gateway unit/testcontainers tests.

// Shared-host container and trace teardown outlasts the 30s default.
test.describe.configure({ timeout: 120_000 });

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

// One operator record shared by every browser context, as the Gateway keeps it.
function operatorStore(initial: string) {
  const store = {
    zone: initial,
    revision: 1,
    writes: [] as { ifMatch?: string; body: unknown }[],
  };
  const attach = (target: Page | BrowserContext) =>
    target.route("**/ui/v1/operator/settings", (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        store.writes.push({
          ifMatch: route.request().headers()["if-match"],
          body,
        });
        store.zone = body.time_zone;
        store.revision++;
      }
      return route.fulfill({
        json: { time_zone: store.zone },
        headers: {
          etag: `"op-${store.revision}"`,
          "cache-control": "no-store",
        },
      });
    });
  return { store, attach };
}

test("v0034.11 saved zone survives fresh themed sessions; theme and browser zone stay per browser", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { store, attach } = operatorStore("UTC");
  const settingsURL = `${proxy.baseUrl}?view=settings&section=operator&team=1`;

  const first = await browser.newContext({ timezoneId: "UTC" });
  try {
    await first.addInitScript(() =>
      localStorage.setItem("flowai.theme", "dark"),
    );
    await attach(first);
    const page = await first.newPage();
    await page.goto(settingsURL);
    const zone = page.getByLabel("Time zone", { exact: true });
    await expect(zone).toHaveValue("UTC");
    await zone.fill("Europe/Moscow");
    expect(store.writes).toEqual([]);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => store.zone).toBe("Europe/Moscow");
    expect(store.writes).toEqual([
      { ifMatch: '"op-1"', body: { time_zone: "Europe/Moscow" } },
    ]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // The preference lives at the Gateway only, never in browser storage.
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
      "flowai.theme",
    ]);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  } finally {
    await first.close();
  }

  const second = await browser.newContext({ timezoneId: "America/New_York" });
  try {
    await second.addInitScript(() =>
      localStorage.setItem("flowai.theme", "light"),
    );
    await attach(second);
    const other = await second.newPage();
    await other.goto(settingsURL);
    await expect(other.getByLabel("Time zone", { exact: true })).toHaveValue(
      "Europe/Moscow",
    );
    await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
    expect(
      await other.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe("America/New_York");
    expect(await other.evaluate(() => Object.keys(localStorage))).toEqual([
      "flowai.theme",
    ]);
    expect(store.writes).toHaveLength(1);
  } finally {
    await second.close();
  }
});

test("v0034.15 focus after an outage or a rejected credential withholds Save and writes nothing", async ({
  page,
}) => {
  for (const failure of ["unavailable", "unauthorized"] as const) {
    let mode: "ok" | typeof failure = "ok";
    let reads = 0,
      writes = 0;
    await page.unrouteAll({ behavior: "wait" });
    await page.route("**/ui/v1/operator/settings", (route) => {
      if (route.request().method() !== "GET") writes++;
      else reads++;
      if (mode === "unavailable")
        return route.fulfill({
          status: 503,
          json: { code: "operator_settings_unavailable" },
        });
      if (mode === "unauthorized")
        return route.fulfill({
          status: 401,
          json: { code: "invalid_working_token" },
        });
      return route.fulfill({
        json: { time_zone: "UTC" },
        headers: { etag: '"op-1"', "cache-control": "no-store" },
      });
    });
    await page.goto(`${proxy.baseUrl}?view=settings&section=operator&team=1`);
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(page.getByLabel("Time zone", { exact: true })).toHaveValue(
      "UTC",
    );
    await expect(save).toBeEnabled();
    mode = failure;
    const before = reads;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(() => reads, { message: failure })
      .toBeGreaterThan(before);
    await expect(save, failure).toBeDisabled();
    expect(writes, failure).toBe(0);
  }
});
