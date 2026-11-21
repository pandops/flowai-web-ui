import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy } from "../fixtures/mocked_proxy";

// Survivor of llm-proxying v0022.8-team-selector.ui.spec.ts (v0041 D15).
// The mocked Gateway issues working tokens per team (`working-<team_id>`);
// the models catalog answers per working token, so a team switch is proven
// by the token request and the reloaded team-scoped data.

test.use({ actionTimeout: 10_000 });

const webEntry = path.resolve(__dirname, "../../../web/index.html");

async function teamModels(page: Page, byTeam: Record<string, string[]>) {
  await page.route("**/ui/v1/models?**", (route) => {
    const team = route
      .request()
      .headers()
      .authorization?.replace(/^Bearer working-/, "");
    const archived =
      new URL(route.request().url()).searchParams.get("archived") === "true";
    return route.fulfill({
      json: {
        items: archived
          ? []
          : (byTeam[team ?? ""] ?? []).map((name) => ({
              name,
              model_alias: `${team}/${name}`,
              provider: "openai",
              provider_model: "x",
              api_base: null,
              credential_configured: false,
              created_by: "team",
              model_id: 8008,
              created_at: "2026-10-18T00:00:00Z",
              updated_at: "2026-10-18T00:00:00Z",
              unfinished_task_count: 0,
              paused: false,
              archived_at: null,
              editable: true,
              can_archive: true,
              can_unarchive: false,
              archive_blocking_flows: [],
              pricing_status: "configured",
              pricing: {
                input_usd_per_million_tokens: "1",
                output_usd_per_million_tokens: "2",
              },
            })),
        next_cursor: null,
      },
    });
  });
}

// One test, one step per original check. Each step starts its own proxy
// (one team, then two) on a blank document and removes its routes and
// listeners when it ends.
test("v0022.8 / web-ui: team selector with one team and with two teams", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await test.step("v0022.8 / web-ui: one team keeps an enabled selector without a token transition", async () => {
    const proxy = await startMockedProxy(
      [{ team_id: 3, team_name: "acme" }],
      webEntry,
    );
    try {
      await teamModels(page, {});
      await page.goto(`${proxy.baseUrl}/?view=settings&section=models&team=3`);
      const selector = page.locator("#team-selector");
      await expect(selector).toBeEnabled();
      await expect(selector.locator("option")).toHaveText(["acme"]);
      await selector.focus();
      await expect(selector).toBeFocused();
      await expect(page.getByText("No current models.")).toBeVisible();
      const tokens = () =>
        proxy.requests.filter((r) => r === "/auth/v1/token").length;
      const before = tokens();
      await selector.selectOption("3");
      await page.waitForTimeout(500);
      expect(tokens()).toBe(before);
      await expect(page.getByText("No current models.")).toBeVisible();
    } finally {
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await proxy.close();
    }
  });
  await test.step("v0022.8 / web-ui: switching teams uses the Gateway token flow; the selector is readable at every width", async () => {
    const proxy = await startMockedProxy(
      [
        { team_id: 3, team_name: "acme" },
        { team_id: 2, team_name: "beta" },
      ],
      webEntry,
    );
    try {
      await teamModels(page, { "3": ["acme-only"] });
      const tokenBodies: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/auth/v1/token")
          tokenBodies.push(request.postData() ?? "");
      });
      await page.goto(`${proxy.baseUrl}/?view=settings&section=models&team=3`);
      const acmeRow = page
        .locator("#models-results tr:visible,#models-results article:visible")
        .filter({
          has: page.getByRole("link", { name: "acme-only", exact: true }),
        });
      await expect(acmeRow).toBeVisible();
      const selector = page.locator("#team-selector");
      const tokenRequests = () =>
        proxy.requests.filter((r) => r === "/auth/v1/token").length;
      const before = tokenRequests();
      await selector.selectOption("2");
      await expect.poll(tokenRequests).toBeGreaterThan(before);
      expect(JSON.parse(tokenBodies.at(-1)!)).toMatchObject({
        team_id: 2,
      });
      await expect(page.getByText("No current models.")).toBeVisible();
      await expect(acmeRow).toHaveCount(0);

      const layout = async () =>
        page.evaluate(() => {
          const box = (selectorText: string) =>
            document
              .querySelector(selectorText)!
              .getBoundingClientRect()
              .toJSON();
          const sidebarIcon = document.querySelector(
            '.layout > nav [data-view="settings"] svg.nav-icon',
          );
          return {
            select: box("#team-selector"),
            topbar: box(".topbar"),
            live: box("[data-live-state]"),
            settingsIcon: sidebarIcon
              ? sidebarIcon.getBoundingClientRect().toJSON()
              : { width: 0, height: 0 },
          };
        });
      const waitForTeamPlacement = async (
        width: number,
        parentSelector: string,
      ) => {
        await expect
          .poll(
            () =>
              selector.evaluate(
                (element, expected) => ({
                  width: innerWidth,
                  placed: element
                    .closest(".team")
                    ?.parentElement?.matches(expected.parentSelector),
                }),
                { parentSelector },
              ),
            { timeout: 5000 },
          )
          .toEqual({ width, placed: true });
      };
      // Tablet: the selector sits in the top bar, wide enough to read, apart
      // from the live status; the Settings icon is visible in the sidebar.
      await page.setViewportSize({ width: 820, height: 1180 });
      await waitForTeamPlacement(820, "#header-team-slot");
      let l = await layout();
      expect(l.select.top).toBeGreaterThanOrEqual(l.topbar.top);
      expect(l.select.bottom).toBeLessThanOrEqual(l.topbar.bottom);
      expect(l.select.width).toBeGreaterThanOrEqual(160);
      expect(
        l.select.right <= l.live.left ||
          l.select.left >= l.live.right ||
          l.live.width === 0,
      ).toBe(true);
      expect(l.settingsIcon.width).toBeGreaterThan(0);
      expect(l.settingsIcon.height).toBeGreaterThan(0);
      const navigation = page.getByRole("navigation", {
        name: "Main navigation",
      });
      for (const name of [
        "Overview",
        "Flows",
        "Tasks",
        "Sources",
        "Settings",
      ]) {
        const link = navigation.getByRole("link", { name, exact: true });
        await expect(link).toBeVisible();
        await expect(link.locator("svg.nav-icon")).toBeVisible();
        expect(
          await link.evaluate((element) =>
            parseFloat(getComputedStyle(element).fontSize),
          ),
        ).toBeGreaterThan(0);
      }
      await expect(selector).toBeEnabled();
      // Phone and desktop: readable and reachable.
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : width === 820 ? 1180 : 900 });
        await waitForTeamPlacement(
          width,
          width > 680 ? "#header-team-slot" : "#mobile-team-slot",
        );
        l = await layout();
        expect(l.select.width, `width ${width}`).toBeGreaterThanOrEqual(120);
        expect(l.select.right, `width ${width}`).toBeLessThanOrEqual(width);
        await selector.focus();
        await expect(selector).toBeFocused();
      }
    } finally {
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await proxy.close();
    }
  });
});
