import path from "node:path";
import type { ConsoleMessage, Request, WebSocket } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivor of api-gateway v0034-design-boundaries.spec.ts (v0041 D15): the
// browser half. Foreign-Source 404 equality and no-store headers are State
// Registry/Gateway unit tests.

// Shared-host container and trace teardown outlasts the 30s default.
test.describe.configure({ timeout: 120_000 });

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [
        { team_id: 1, team_name: "alpha" },
        { team_id: 2, team_name: "beta" },
      ],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

const sources = {
  "1": {
    source_id: 8028,
    name: "tenant-sentinel-0",
  },
  "2": {
    source_id: 8029,
    name: "tenant-sentinel-1",
  },
} as const;

// One test, one step per original theme case. Each step starts from a blank
// document with no stored theme, its own colour-scheme emulation, routes and
// listeners, and removes them when it ends.
test("v0034.11 baseline, dark and light browser tenant boundaries, same-origin requests and theme toggle", async ({
  page,
}) => {
  for (const theme of [null, "dark", "light"] as const)
    await test.step(`v0034.11 ${theme ?? "baseline"} browser tenant boundaries, same-origin requests and theme toggle`, async () => {
      await page.goto("about:blank");
      if (theme)
        await page.emulateMedia({
          colorScheme: theme === "dark" ? "light" : "dark",
        });
      await page.route("**/ui/v1/sources?**", (route) => {
        const team = route
          .request()
          .headers()
          .authorization?.replace(
            /^Bearer working-/,
            "",
          ) as keyof typeof sources;
        const source = sources[team];
        return route.fulfill({
          json: {
            items: source
              ? [
                  {
                    ...source,
                    team_id: team,
                    revision: 1,
                    mode: "webhook",
                    enabled: true,
                    contract_version: "source.v1",
                    implementation_version: "1",
                    description: "",
                    filter_summary: "",
                    settings_status: "complete",
                    health: "healthy",
                    last_seen_at: null,
                    polling: null,
                    last_poll: null,
                    webhook_url: `https://receiver.example/webhook/${team}/${source.name}/task`,
                    intake_counts: {
                      published: 0,
                      rejected: 0,
                      accepted: 0,
                      deduplicated: 0,
                      no_target: 0,
                      failed: 0,
                    },
                  },
                ]
              : [],
            next_cursor: null,
          },
        });
      });
      await page.route(
        /\/ui\/v1\/(?:flow-llm-settings|models)(?:\?.*)?$/,
        (route) => route.fulfill({ json: { items: [], next_cursor: null } }),
      );
      const destinations: string[] = [];
      const socketHosts: string[] = [];
      const consoleMessages: string[] = [];
      const onRequest = (request: Request) =>
        destinations.push(new URL(request.url()).origin);
      const onWebSocket = (socket: WebSocket) =>
        socketHosts.push(new URL(socket.url()).host);
      const onConsole = (message: ConsoleMessage) =>
        consoleMessages.push(message.text());
      page.on("request", onRequest);
      page.on("websocket", onWebSocket);
      page.on("console", onConsole);
      try {
        const origin = new URL(proxy.baseUrl).origin;

        await page.goto(`${proxy.baseUrl}/?view=sources&team=1`);
        const selector = page.getByRole("combobox", {
          name: "Team",
          exact: true,
        });
        await expect(selector).toHaveValue("1");
        const own = page.getByRole("link", {
          name: sources["1"].name,
          exact: true,
        });
        await expect(own).toBeVisible();
        await expect(own).toHaveAttribute(
          "href",
          `?view=source&team=1&id=${sources["1"].source_id}`,
        );
        await expect(
          page.getByText(sources["2"].name, { exact: true }),
        ).toHaveCount(0);
        expect(destinations.length).toBeGreaterThan(0);
        expect(new Set(destinations)).toEqual(new Set([origin]));

        const storage = () =>
          page.evaluate(() => ({
            local: { ...localStorage },
            session: { ...sessionStorage },
          }));
        const before = await storage();
        if (theme) {
          const toggle = page.getByRole("button", {
            name: `Switch to ${theme} theme`,
            exact: true,
          });
          await expect(toggle).toBeVisible();
          await toggle.click();
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          expect(
            await page.evaluate(() => localStorage.getItem("flowai.theme")),
          ).toBe(theme);
        }
        const after = await storage();
        const local = { ...after.local } as Record<string, string>;
        delete local["flowai.theme"];
        const beforeLocal = { ...before.local } as Record<string, string>;
        delete beforeLocal["flowai.theme"];
        expect(local).toEqual(beforeLocal);
        expect(after.session).toEqual(before.session);
        // The memory-held working credential never reaches storage, the URL,
        // the DOM or the console.
        const observed = JSON.stringify({
          text: await page.evaluate(() => document.documentElement.outerHTML),
          url: page.url(),
          ...after,
        });
        expect(observed).not.toContain("working-1");
        expect(consoleMessages.join("\n")).not.toContain("working-1");

        await selector.selectOption("2");
        const foreign = page.getByRole("link", {
          name: sources["2"].name,
          exact: true,
        });
        await expect(foreign).toBeVisible();
        await expect(foreign).toHaveAttribute(
          "href",
          `?view=source&team=2&id=${sources["2"].source_id}`,
        );
        await expect(
          page.getByText(sources["1"].name, { exact: true }),
        ).toHaveCount(0);
        if (theme)
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
        expect(new Set(destinations)).toEqual(new Set([origin]));
        expect(socketHosts.length).toBeGreaterThan(0);
        expect(new Set(socketHosts)).toEqual(new Set([new URL(origin).host]));
      } finally {
        page.off("request", onRequest);
        page.off("websocket", onWebSocket);
        page.off("console", onConsole);
        // The toggle stores the chosen theme; the next step starts without it.
        if (page.url().startsWith(proxy.baseUrl))
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });
        await page.goto("about:blank");
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }
    });
});
