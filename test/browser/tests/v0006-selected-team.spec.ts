import path from "node:path";
import type { Page, Request } from "@playwright/test";

import { expect, test } from "../fixtures/owned-test";

import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";

let proxy: MockedProxy;

test.beforeAll(async () => {
  proxy = await startMockedProxy(
    [
      { team_id: 1, team_name: "alpha" },
      { team_id: 2, team_name: "beta" },
    ],
    path.resolve(__dirname, "../../../web/index.html"),
  );
});

test.afterAll(async () => {
  // Stopping the Web UI container can outlast the default hook budget on a
  // loaded host; the start already gets the same allowance.
  test.setTimeout(120_000);
  await proxy.close();
});

// One test, one step per original check. Each step starts from a blank
// document with its own request listener, which it removes when it ends;
// the proxy's launch-parameter writes are stateless.
async function isolatedStep(
  page: Page,
  title: string,
  body: (
    onRequest: (listener: (request: Request) => void) => void,
  ) => Promise<void>,
) {
  await test.step(title, async () => {
    const listeners: Array<(request: Request) => void> = [];
    await page.goto("about:blank");
    try {
      await body((listener) => {
        listeners.push(listener);
        page.on("request", listener);
      });
    } finally {
      for (const listener of listeners) page.off("request", listener);
    }
  });
}

test("v0006.1-.5 / v0007.5-v0007.7 selected team context, proxy origin, team-scoped mutations, bearer-only requests and memory-only credentials", async ({
  page,
}) => {
  // The v0007 step starts and stops its own Web UI proxy: about 6 s idle,
  // but 20-31 s under full parallel run load.
  test.setTimeout(180_000);

  await isolatedStep(
    page,
    "v0006.1 selects one supplied team and replaces context on switch",
    async () => {
      const start = proxy.requests.length;
      await page.goto(proxy.baseUrl);

      const selector = page.getByRole("combobox", {
        name: "Team",
        exact: true,
      });
      await expect(selector).toHaveValue("1");
      await expect(selector.locator("option")).toHaveText(["alpha", "beta"]);

      await selector.selectOption("2");
      await expect(selector).toHaveValue("2");
      await expect(page.getByTestId("selected-team-id")).toHaveText("2");

      await expect
        .poll(() =>
          proxy.requests
            .slice(start)
            .some((request) => request.includes("/teams/2/")),
        )
        .toBe(true);
    },
  );

  await isolatedStep(
    page,
    "v0006.2 browser uses only the configured mocked proxy origin",
    async (onRequest) => {
      const destinations = new Set<string>();
      onRequest((request) => destinations.add(new URL(request.url()).origin));

      await page.goto(proxy.baseUrl);
      await expect(
        page.getByRole("combobox", { name: "Team", exact: true }),
      ).toBeVisible();
      expect([...destinations]).toEqual([new URL(proxy.baseUrl).origin]);
    },
  );

  await isolatedStep(
    page,
    "v0006.3 mutations use the currently selected team id",
    async (onRequest) => {
      const mutations: Array<{ method: string; path: string }> = [];
      onRequest((request) => {
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
          mutations.push({
            method: request.method(),
            path: new URL(request.url()).pathname,
          });
        }
      });
      await page.goto(proxy.baseUrl);
      await page
        .getByRole("combobox", { name: "Team", exact: true })
        .selectOption("2");
      await page.getByRole("link", { name: "Settings" }).click();
      await page
        .getByRole("button", { name: "Create parameter", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Add variable", exact: true })
        .click();
      await page
        .locator("#env-dialog")
        .getByLabel("Key name", { exact: true })
        .fill("FLOWAI_E2E_VISIBLE");
      await page
        .locator("#env-dialog")
        .getByLabel("Value", { exact: true })
        .fill("visible-value");
      await page
        .getByRole("button", { name: "Save variable", exact: true })
        .click();

      await expect
        .poll(() =>
          mutations.some(
            ({ path }) =>
              path === "/ui/v1/teams/2/launch-parameters" ||
              path.startsWith("/ui/v1/teams/2/launch-parameters/"),
          ),
        )
        .toBe(true);
      expect(
        mutations.some(({ path }) =>
          path.startsWith("/ui/v1/teams/1/launch-parameters"),
        ),
      ).toBe(false);
    },
  );

  await isolatedStep(
    page,
    "v0006.4 v0007.7 sends selected team with bearer but without trusted auth context",
    async (onRequest) => {
      const headers: Record<string, string>[] = [];
      onRequest((request) => headers.push(request.headers()));

      await page.goto(proxy.baseUrl);
      await page
        .getByRole("combobox", { name: "Team", exact: true })
        .selectOption("2");

      await expect
        .poll(() =>
          headers.some((value) => value.authorization === "Bearer working-2"),
        )
        .toBe(true);
      expect(headers.some((value) => "x-flowai-operator-id" in value)).toBe(
        false,
      );
      expect(headers.some((value) => "x-flowai-team-id" in value)).toBe(false);
    },
  );

  await isolatedStep(
    page,
    "v0006.5 refresh rebuilds the selected-team view from the adapter",
    async () => {
      await page.goto(proxy.baseUrl);
      await page
        .getByRole("combobox", { name: "Team", exact: true })
        .selectOption("2");
      await expect(page.getByTestId("selected-team-id")).toHaveText("2");

      await page.reload();
      await expect(
        page.getByRole("combobox", { name: "Team", exact: true }),
      ).toHaveValue("2");
      await expect(page.getByTestId("selected-team-id")).toHaveText("2");
    },
  );

  // Moved from v0007-authenticated-surface.spec.ts: it needs its own proxy
  // (an archived Beta team and a fresh WebSocket upgrade record).
  await isolatedStep(
    page,
    "v0007.5-v0007.7 use resolved teams and memory-only one-team credentials",
    async (onRequest) => {
      const proxy = await startMockedProxy(
        [
          { team_id: 1, team_name: "alpha-team", archived_at: null },
          {
            team_id: 2,
            team_name: "beta-team",
            archived_at: "2026-08-27T00:00:00Z",
          },
        ],
        path.resolve(__dirname, "../../../web/index.html"),
      );
      const browserRequests: Array<{
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string | null;
      }> = [];
      onRequest((request) =>
        browserRequests.push({
          url: request.url(),
          method: request.method(),
          headers: request.headers(),
          body: request.postData(),
        }),
      );
      try {
        await page.goto(proxy.baseUrl);
        const selector = page.getByRole("combobox", {
          name: "Team",
          exact: true,
        });
        await expect(selector.locator("option")).toHaveText([
          "alpha-team",
          "beta-team (archived)",
        ]);
        await expect(
          page.getByRole("button", {
            name: /create team|archive team|add member/i,
          }),
        ).toHaveCount(0);

        await selector.selectOption("2");
        await expect(page.getByTestId("selected-team-id")).toHaveText("2");
        await expect
          .poll(() =>
            browserRequests.some(
              (request) =>
                request.method === "POST" &&
                new URL(request.url).pathname === "/auth/v1/token" &&
                request.body === JSON.stringify({ team_id: 2 }),
            ),
          )
          .toBe(true);
        await expect
          .poll(() =>
            browserRequests.some(
              (request) => request.headers.authorization === "Bearer working-2",
            ),
          )
          .toBe(true);
        expect(
          browserRequests.every(
            (request) =>
              !Object.keys(request.headers).some((name) =>
                name.toLowerCase().startsWith("x-flowai-"),
              ),
          ),
        ).toBe(true);
        const expectedProtocol = `flowai.bearer.${Buffer.from("working-2").toString("base64url")}`;
        await expect
          .poll(() =>
            proxy.upgradeHeaders.some(
              (headers) =>
                headers["sec-websocket-protocol"] === expectedProtocol,
            ),
          )
          .toBe(true);
        const protocols = String(
          proxy.upgradeHeaders.at(-1)?.["sec-websocket-protocol"] ?? "",
        );
        expect(protocols).toBe(expectedProtocol);
        expect(
          proxy.upgradeHeaders.at(-1)?.["x-flowai-team-id"],
        ).toBeUndefined();

        await page.reload();
        await expect
          .poll(
            () =>
              browserRequests.filter(
                (request) =>
                  request.method === "POST" &&
                  new URL(request.url).pathname === "/auth/v1/token",
              ).length,
          )
          .toBeGreaterThan(2);
      } finally {
        await page.goto("about:blank");
        await proxy.close();
      }
    },
  );
});
