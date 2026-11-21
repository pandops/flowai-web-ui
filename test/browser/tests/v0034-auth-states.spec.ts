import type { Page, Request, Route } from "@playwright/test";
import { captureDesignState, designViewport } from "../fixtures/design-capture";
import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

let proxy: MockedProxy;
test.use({ actionTimeout: 10_000 });
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
test.beforeEach(async ({ page }) => {
  for (const resource of ["sources", "flows"])
    await page.route(`**/ui/v1/${resource}?**`, (route) =>
      route.fulfill({ json: { items: [], next_cursor: null } }),
    );
});

// Merged tests run one step per original check. Each step starts from a
// blank document with its own routes, listeners and held responses, and
// removes them when it ends, so no step sees another step's state. Only
// `flowai.theme` is ever persisted by the Web UI.
type Handler = (route: Route, request: Request) => unknown;
type Scope = {
  route: (url: string | RegExp, handler: Handler) => Promise<void>;
  on: (event: "request" | "pageerror", listener: (value: any) => void) => void;
};
async function isolatedStep(
  page: Page,
  title: string,
  body: (scope: Scope) => Promise<void>,
  theme?: string,
) {
  await test.step(title, async () => {
    const routes: Array<[string | RegExp, Handler]> = [];
    const listeners: Array<["request" | "pageerror", (value: any) => void]> =
      [];
    await page.goto("about:blank");
    // A later init script runs after earlier ones, so this step's theme wins.
    if (theme)
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
    try {
      await body({
        route: async (url, handler) => {
          routes.push([url, handler]);
          await page.route(url, handler);
        },
        on: (event, listener) => {
          listeners.push([event, listener]);
          page.on(event as "request", listener);
        },
      });
    } finally {
      for (const [event, listener] of listeners)
        page.off(event as "request", listener);
      for (const [url, handler] of routes) await page.unroute(url, handler);
    }
  });
}

const teamSets = {
  default: [{ team_id: 1, team_name: "alpha" }],
  "one-team": [{ team_id: 1, team_name: "alpha" }],
  "many-teams": [
    { team_id: 1, team_name: "alpha" },
    { team_id: 2, team_name: "beta" },
    { team_id: 4, team_name: "gamma" },
  ],
  "archived-team": [
    {
      team_id: 1,
      team_name: "alpha",
      archived_at: "2026-10-01T00:00:00Z",
    },
  ],
  "team-switch-pending": [
    { team_id: 1, team_name: "alpha" },
    { team_id: 2, team_name: "beta" },
  ],
} as const;

// Team-context cells: one, several and archived mapped teams, the default
// authenticated shell and a pending switch.
async function teamContext(
  page: Page,
  scope: Scope,
  state: keyof typeof teamSets,
  theme: string,
  width: number,
) {
  const teams = teamSets[state];
  await scope.route("**/auth/v1/teams", (route) =>
    route.fulfill({ json: { teams } }),
  );
  let release!: () => void,
    held = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await scope.route("**/auth/v1/token", async (route) => {
    if (route.request().postDataJSON().team_id === 2) {
      held = true;
      await pending;
    }
    await route.fallback().catch(() => undefined);
  });
  try {
    await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
    const selector = page.getByRole("combobox", {
      name: "Team",
      exact: true,
    });
    await expect(page.locator("#source-results")).toContainText(
      /no records available/i,
    );
    // A single mapped team keeps an enabled selector without inventing
    // membership; archived teams stay selectable for existing data.
    await expect(selector).toBeEnabled();
    await expect(selector.locator("option")).toHaveCount(teams.length);
    await expect(page.getByTestId("selected-team-id")).toHaveText("1");
    if (state === "archived-team")
      await expect(selector.locator("option")).toHaveText(["alpha (archived)"]);
    if (state === "team-switch-pending") {
      await selector.selectOption("2");
      await expect.poll(() => held).toBe(true);
      await expect(page.locator("#app [role=status]")).toContainText(
        /selecting|loading|switching/i,
      );
      await expect(page.locator("#source-results")).toHaveCount(0);
    }
    await captureDesignState(
      page,
      test.info(),
      proxy.webUIImageID,
      `auth.html-${state}-${theme}-${width}`,
    );
  } finally {
    release();
  }
}

async function pendingBootstrap(
  page: Page,
  scope: Scope,
  theme: string,
  width: number,
) {
  let release!: () => void,
    captured = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await scope.route("**/auth/v1/teams", async (route) => {
    captured = true;
    await held;
    await route.fallback().catch(() => undefined);
  });
  try {
    await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
    await expect.poll(() => captured).toBe(true);
    await expect(page.locator("#app [role=status]")).toContainText(
      /Loading….*withheld until Gateway confirms/,
    );
    await expect(page.locator("#app table,#app article")).toHaveCount(0);
    await captureDesignState(
      page,
      test.info(),
      proxy.webUIImageID,
      `auth.html-loading-${theme}-${width}`,
    );
    release();
    await expect(
      page.getByRole("heading", { name: "Sources", level: 1, exact: true }),
    ).toBeVisible();
    await expect(page.locator("#source-results")).toContainText(
      /no records available/i,
    );
  } finally {
    release();
  }
}

type BootstrapScenario =
  | "signed out"
  | "team failure"
  | "no teams"
  | "token failure";
async function bootstrapScenario(
  page: Page,
  scope: Scope,
  scenario: BootstrapScenario,
  theme: string,
  width: number,
) {
  const uiRequests: string[] = [];
  scope.on("request", (request: Request) => {
    if (new URL(request.url()).pathname.startsWith("/ui/v1/"))
      uiRequests.push(request.url());
  });
  let recovering = false;
  await scope.route("**/auth/v1/teams", (route) => {
    if (recovering) return route.fallback();
    if (scenario === "signed out")
      return route.fulfill({
        status: 401,
        json: { code: "authentication_required" },
      });
    if (scenario === "team failure")
      return route.fulfill({
        status: 503,
        json: { code: "unavailable" },
      });
    if (scenario === "no teams") return route.fulfill({ json: { teams: [] } });
    return route.fallback();
  });
  if (scenario === "token failure")
    await scope.route("**/auth/v1/token", (route) =>
      recovering
        ? route.fallback()
        : route.fulfill({ status: 503, json: { code: "unavailable" } }),
    );
  await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  if (scenario === "signed out") {
    // Approved Gateway access panel: one primary command that
    // leaves for the configured Gateway login (checked below).
    await expect(
      page.getByRole("button", {
        name: "Continue to Gateway",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('input[type="password"]:visible')).toHaveCount(0);
  } else if (scenario === "no teams") {
    await expect(page.locator("#app").getByRole("status")).toContainText(
      "No mapped teams",
    );
    // The gate shows no team selector; the hidden control stays disabled.
    await expect(page.locator("#team-selector")).toBeDisabled();
    await expect(page.locator("#team-selector")).toBeHidden();
  } else {
    await expect(page.getByRole("alert")).toContainText("Request failed");
    expect(uiRequests).toEqual([]);
    await captureDesignState(
      page,
      test.info(),
      proxy.webUIImageID,
      `auth.html-${scenario === "team failure" ? "failure" : "token-issue-failure"}-${theme}-${width}`,
    );
    // Owner review 2026-10-25: auth.html shows no in-place Retry
    // command; recovery reloads the page.
    await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
    recovering = true;
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: "Sources",
        level: 1,
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#source-results")).toContainText(
      /no records available/i,
    );
    await expect(page.locator("#app [role=alert]")).toHaveCount(0);
  }
  if (scenario === "signed out" || scenario === "no teams")
    expect(uiRequests).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await captureDesignState(
    page,
    test.info(),
    proxy.webUIImageID,
    `${scenario === "signed out" ? "auth.html-signed-out" : scenario === "no teams" ? "auth.html-no-teams" : "recovered-" + scenario}-${theme}-${width}`,
  );
  if (scenario === "signed out") {
    await scope.route("**/auth/v1/login", (route) =>
      route.fulfill({ contentType: "text/html", body: "Gateway login" }),
    );
    await page
      .getByRole("button", { name: "Continue to Gateway", exact: true })
      .click();
    await expect(page).toHaveURL(/\/auth\/v1\/login$/);
  }
}

const bootstrapTitle = (
  scenario: BootstrapScenario,
  theme: string,
  width: number,
) =>
  `v0034.9 ${scenario} retains themed safe bootstrap and recovery ${theme} ${width}`;
const teamContextTitle = (state: string, theme: string, width: number) =>
  `v0034.9 team context ${state} keeps the canonical team conspicuous ${theme} ${width}`;

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.9 auth.html states: team context, pending bootstrap, failures, no teams, pending switch and signed out ${theme} ${width}`, async ({
      page,
    }) => {
      // Ten states with up to two captures each in one cell.
      test.setTimeout(180_000);
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      for (const state of [
        "default",
        "one-team",
        "many-teams",
        "archived-team",
      ] as const)
        await isolatedStep(
          page,
          teamContextTitle(state, theme, width),
          (scope) => teamContext(page, scope, state, theme, width),
        );
      await isolatedStep(
        page,
        `v0034.9 pending team bootstrap exposes truthful loading and no scoped records ${theme} ${width}`,
        (scope) => pendingBootstrap(page, scope, theme, width),
      );
      for (const scenario of [
        "team failure",
        "token failure",
        "no teams",
      ] as const)
        await isolatedStep(
          page,
          bootstrapTitle(scenario, theme, width),
          (scope) => bootstrapScenario(page, scope, scenario, theme, width),
        );
      await isolatedStep(
        page,
        teamContextTitle("team-switch-pending", theme, width),
        (scope) =>
          teamContext(page, scope, "team-switch-pending", theme, width),
      );
      // Last: it leaves the Web UI for the Gateway login.
      await isolatedStep(
        page,
        bootstrapTitle("signed out", theme, width),
        (scope) => bootstrapScenario(page, scope, "signed out", theme, width),
      );
    });

test("v0034.9 team switch clears previous scoped records before a held replacement token", async ({
  page,
}) => {
  for (const theme of ["dark", "light"])
    await isolatedStep(
      page,
      `v0034.9 team switch clears previous scoped records before a held replacement token ${theme}`,
      async (scope) => {
        let release!: () => void,
          captured = false;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await scope.route("**/auth/v1/token", async (route) => {
          if (route.request().postDataJSON().team_id === 2) {
            captured = true;
            await held;
          }
          await route.fallback().catch(() => undefined);
        });
        await scope.route("**/ui/v1/sources?**", (route) => {
          const team = route.request().headers().authorization?.endsWith("2")
            ? "beta"
            : "alpha";
          return route.fulfill({
            json: {
              items: [
                {
                  source_id: team === "alpha" ? 8028 : 8029,
                  name: `${team}-only-source`,
                  team_id: team === "alpha" ? 1 : 2,
                  mode: "webhook",
                  enabled: true,
                  revision: 1,
                  implementation_version: "fixture",
                  contract_version: "source.v1",
                  health: "never_seen",
                  settings_status: "complete",
                  created_at: "2026-10-18T00:00:00Z",
                  polling: null,
                  last_poll: null,
                  last_seen_at: null,
                  webhook_url: `${proxy.baseUrl}/webhook/${team === "alpha" ? 1 : 2}/${team === "alpha" ? 8028 : 8029}/task`,
                  intake_counts: {
                    published: 0,
                    rejected: 0,
                    accepted: 0,
                    deduplicated: 0,
                    no_target: 0,
                    failed: 0,
                  },
                },
              ],
              next_cursor: null,
            },
          });
        });
        try {
          await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
          await expect(
            page.getByRole("link", { name: "alpha-only-source", exact: true }),
          ).toBeVisible();
          await page
            .getByRole("combobox", { name: "Team", exact: true })
            .selectOption("2");
          await expect.poll(() => captured).toBe(true);
          await expect(page.locator("#app")).not.toContainText(
            "alpha-only-source",
          );
          await expect(page.locator("#app [role=status]")).toContainText(
            /switching team/i,
          );
          release();
          await expect(
            page.getByRole("link", { name: "beta-only-source", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("link", { name: "alpha-only-source", exact: true }),
          ).toHaveCount(0);
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({
            "flowai.theme": theme,
          });
        } finally {
          release();
        }
      },
      theme,
    );
});

test("v0034.9 team switch HTTP unavailable and network failure expose scoped recovery without unhandled rejection", async ({
  page,
}) => {
  for (const theme of ["dark", "light"])
    for (const failure of ["HTTP unavailable", "network failure"] as const)
      await isolatedStep(
        page,
        `v0034.9 team switch ${failure} exposes scoped recovery without unhandled rejection ${theme}`,
        async (scope) => {
          const errors: string[] = [],
            reads: Array<{ path: string; authorization: string | undefined }> =
              [];
          scope.on("pageerror", (error: Error) => errors.push(error.message));
          let unavailable = true;
          await scope.route("**/auth/v1/token", (route) => {
            if (route.request().postDataJSON().team_id !== 2 || !unavailable)
              return route.fallback();
            return failure === "network failure"
              ? route.abort("failed")
              : route.fulfill({ status: 503, json: { code: "unavailable" } });
          });
          await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
          await expect(page.locator("#source-results")).toContainText(
            /no records available/i,
          );
          scope.on("request", (request: Request) => {
            const path = new URL(request.url()).pathname;
            if (path.startsWith("/ui/v1/"))
              reads.push({
                path,
                authorization: request.headers().authorization,
              });
          });
          await page
            .getByRole("combobox", { name: "Team", exact: true })
            .selectOption("2");
          await expect(page.locator("#app [role=alert]")).toContainText(
            /team|token|session/i,
          );
          await expect(page.locator("#source-results")).toHaveCount(0);
          expect(reads).toEqual([]);
          expect(errors).toEqual([]);
          await captureDesignState(
            page,
            test.info(),
            proxy.webUIImageID,
            `team-switch-${failure}-${theme}`,
          );
          // Owner review 2026-10-25: auth.html shows no in-place Retry
          // command; recovery reloads the previous team URL and switches
          // again.
          await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(
            0,
          );
          unavailable = false;
          await page.reload();
          await expect(page.locator("#source-results")).toContainText(
            /no records available/i,
          );
          reads.length = 0;
          await page
            .getByRole("combobox", { name: "Team", exact: true })
            .selectOption("2");
          await expect(page.getByTestId("selected-team-id")).toHaveText("2");
          await expect(page.locator("#source-results")).toContainText(
            /no records available/i,
          );
          expect(reads.length).toBeGreaterThan(0);
          expect(
            reads.every((read) => read.authorization === "Bearer working-2"),
          ).toBe(true);
          expect(errors).toEqual([]);
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
        },
        theme,
      );
});

// Kept per theme: `page.clock.install()` cannot be undone for later steps.
for (const theme of ["dark", "light"])
  test(`v0034.9 stream reconnect waits for the replacement team credential ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("flowai.theme", theme),
      theme,
    );
    const sockets: import("@playwright/test").WebSocket[] = [];
    page.on("websocket", (socket) => sockets.push(socket));
    let release!: () => void,
      captured = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/auth/v1/token", async (route) => {
      if (route.request().postDataJSON().team_id === 2) {
        captured = true;
        await held;
      }
      await route.fallback();
    });
    const baseline = proxy.upgradeHeaders.length;
    try {
      await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
      await expect(page.locator("#source-results")).toContainText(
        /no records available/i,
      );
      await expect.poll(() => sockets.length).toBe(1);
      await expect.poll(() => proxy.upgradeHeaders.length).toBe(baseline + 1);
      await expect(page.locator("[data-stream-state=connected]")).toHaveCount(
        1,
      );
      await page.clock.install();
      const departing = sockets[0].waitForEvent("close");
      await page
        .getByRole("combobox", { name: "Team", exact: true })
        .selectOption("2");
      await expect.poll(() => captured).toBe(true);
      await departing;
      // Exercise more than two browser reconnect intervals while the actual
      // replacement token response is still held. Do not invent a new token.
      await page.clock.runFor(1500);
      expect(sockets).toHaveLength(1);
      expect(proxy.upgradeHeaders.length).toBe(baseline + 1);
      release();
      await expect(page.getByTestId("selected-team-id")).toHaveText("2");
      await expect.poll(() => sockets.length).toBe(2);
      await expect
        .poll(() => proxy.upgradeHeaders.at(-1)?.["sec-websocket-protocol"])
        .toBe(
          `flowai.bearer.${Buffer.from("working-2").toString("base64url")}`,
        );
    } finally {
      release();
    }
  });

test("v0034.9 selecting a team during initial token loading still refreshes its saved-zone calendar", async ({
  page,
}) => {
  for (const theme of ["dark", "light"])
    await isolatedStep(
      page,
      `v0034.9 selecting a team during initial token loading still refreshes its saved-zone calendar ${theme}`,
      async (scope) => {
        let release!: () => void,
          captured = false;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await scope.route("**/auth/v1/token", async (route) => {
          if (route.request().postDataJSON().team_id === 1) {
            captured = true;
            await held;
          }
          await route.fallback().catch(() => undefined);
        });
        let zone = "UTC",
          preferenceReads = 0;
        await scope.route("**/ui/v1/operator/settings", (route) => {
          preferenceReads++;
          return route.fulfill({
            json: { time_zone: zone },
            headers: { etag: zone === "UTC" ? '"op-1"' : '"op-2"' },
          });
        });
        const calendars: URL[] = [];
        scope.on("request", (request: Request) => {
          const url = new URL(request.url());
          if (url.pathname === "/ui/v1/teams/2/dashboard") calendars.push(url);
        });
        try {
          await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
          await expect.poll(() => captured).toBe(true);
          await page
            .getByRole("combobox", { name: "Team", exact: true })
            .selectOption("2");
          await expect(page.getByTestId("selected-team-id")).toHaveText("2");
          await expect(page.locator("#source-results")).toContainText(
            /no records available/i,
          );
          await page
            .getByRole("link", { name: "Overview", exact: true })
            .click();
          await expect
            .poll(() =>
              calendars.some(
                (url) => url.searchParams.get("time_zone") === "UTC",
              ),
            )
            .toBe(true);
          const before = preferenceReads;
          zone = "Europe/Moscow";
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect.poll(() => preferenceReads).toBeGreaterThan(before);
          await expect
            .poll(() =>
              calendars.some(
                (url) => url.searchParams.get("time_zone") === zone,
              ),
            )
            .toBe(true);
          const completed = page.waitForResponse(
            (response) =>
              response.url().endsWith("/auth/v1/token") &&
              response.request().postDataJSON().team_id === 1,
          );
          release();
          await (await completed).body();
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          await expect(page.getByTestId("selected-team-id")).toHaveText("2");
          await expect(page).toHaveURL(/team=2/);
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
        } finally {
          release();
        }
      },
      theme,
    );
});

test("v0034.9 same-team Back during initial preference loading completes bootstrap and zone refresh", async ({
  page,
}) => {
  for (const theme of ["dark", "light"])
    await isolatedStep(
      page,
      `v0034.9 same-team Back during initial preference loading completes bootstrap and zone refresh ${theme}`,
      async (scope) => {
        let release!: () => void,
          preferenceReads = 0,
          zone = "UTC";
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await scope.route("**/ui/v1/operator/settings", async (route) => {
          const initial = ++preferenceReads === 1;
          if (initial) await held;
          await route
            .fulfill({
              json: { time_zone: zone },
              headers: { etag: zone === "UTC" ? '"op-1"' : '"op-2"' },
            })
            .catch(() => undefined);
        });
        const calendars: URL[] = [];
        scope.on("request", (request: Request) => {
          const url = new URL(request.url());
          if (url.pathname === "/ui/v1/teams/1/dashboard") calendars.push(url);
        });
        try {
          await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
          await expect.poll(() => preferenceReads).toBe(1);
          await page
            .getByRole("link", { name: "Overview", exact: true })
            .click();
          await expect(page).toHaveURL(/view=dashboard/);
          await page.goBack();
          await expect(page).toHaveURL(/view=sources/);
          release();
          await expect(page.locator("#source-results")).toContainText(
            /no records available/i,
          );
          await expect(
            page.locator("[data-stream-state=connected]"),
          ).toHaveCount(1);
          await page
            .getByRole("link", { name: "Overview", exact: true })
            .click();
          await expect
            .poll(() =>
              calendars.some(
                (url) => url.searchParams.get("time_zone") === "UTC",
              ),
            )
            .toBe(true);
          const before = preferenceReads;
          zone = "Europe/Moscow";
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect.poll(() => preferenceReads).toBeGreaterThan(before);
          await expect
            .poll(() =>
              calendars.some(
                (url) => url.searchParams.get("time_zone") === zone,
              ),
            )
            .toBe(true);
          await expect(page.getByTestId("selected-team-id")).toHaveText("1");
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
        } finally {
          release();
        }
      },
      theme,
    );
});

test("v0034.9 cross-team Back and Forward never reuse another team's stream continuation", async ({
  page,
}) => {
  const streams: import("@playwright/test").WebSocketRoute[] = [];
  // Synthetic upstream frames exercise browser continuation ownership. This
  // does not qualify the real Gateway's stream authorization or proxy relay.
  // One WebSocket route for the whole page; each step starts a new list.
  await page.routeWebSocket(
    /\/ui\/v1\/teams\/[^/]+\/stream(?:\?|$)/,
    (socket) => {
      streams.push(socket);
    },
  );
  for (const theme of ["dark", "light"])
    await isolatedStep(
      page,
      `v0034.9 cross-team Back and Forward never reuse another team's stream continuation ${theme}`,
      async () => {
        streams.length = 0;
        const sendMarker = async (
          index: number,
          team: string,
          frameID: number,
        ) => {
          const teamID = Number(team),
            taskID = team === "1" ? 8028 : 8029;
          // A journal frame: frame_id is the stored event's event_id.
          streams[index].send(
            JSON.stringify({
              frame_id: frameID,
              frame_type: "task_event",
              team_id: teamID,
              task_id: taskID,
              data: {
                event_id: frameID,
                publisher: "task-manager",
                publisher_seq: frameID,
                team_id: teamID,
                task_id: taskID,
                occurred_at: "2026-10-18T12:00:00Z",
                kind: "created",
              },
            }),
          );
          await expect(page.getByTestId("live-frame")).toContainText(
            `"frame_id":${frameID}`,
          );
        };
        const fresh = (index: number, team: string) => {
          const url = new URL(streams[index].url());
          expect(url.pathname).toBe(`/ui/v1/teams/${team}/stream`);
          // A fresh stream of another team carries no resume cursor.
          expect([...url.searchParams.keys()]).not.toContain("after_frame_id");
          expect([...url.searchParams.keys()]).not.toContain("after");
        };
        await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
        await expect(page.locator("[data-stream-state=connected]")).toHaveCount(
          1,
        );
        await expect.poll(() => streams.length).toBe(1);
        await sendMarker(0, "1", 8013);
        await page
          .getByRole("combobox", { name: "Team", exact: true })
          .selectOption("2");
        await expect.poll(() => streams.length).toBe(2);
        fresh(1, "2");
        await sendMarker(1, "2", 8014);
        await page.goBack();
        await expect(page.getByTestId("selected-team-id")).toHaveText("1");
        await expect.poll(() => streams.length).toBe(3);
        fresh(2, "1");
        await sendMarker(2, "1", 8030);
        await page.goForward();
        await expect(page.getByTestId("selected-team-id")).toHaveText("2");
        await expect.poll(() => streams.length).toBe(4);
        fresh(3, "2");
        await expect(page.locator("#source-results")).toContainText(
          /no records available/i,
        );
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      },
      theme,
    );
});
