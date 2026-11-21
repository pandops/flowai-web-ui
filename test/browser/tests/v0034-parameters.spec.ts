import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { parameterFixture } from "../fixtures/v0034-parameters";
import { captureDesignState } from "../fixtures/design-capture";
// Approved confirmation commands name the deleted parameter kind.
const deleteAction = (kind: string) =>
  kind === "definition" ? "Delete parameters" : `Delete ${kind}`;

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

for (const theme of ["dark", "light"] as const)
  for (const [width, height] of [
    [390, 844],
    [820, 1180],
    [1440, 900],
  ]) {
    test(`v0034.12 Parameter definition presentation states ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout(180_000);
      const captures: string[] = [];
      for (const state of [
        "default",
        "team",
        "flow",
        "flow-secret-only",
        "empty-flow-definition",
        "loading",
        "error",
        "unavailable",
      ]) {
        const page = await context.newPage();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const failures: unknown[] = [];
        try {
          await page.setViewportSize({ width, height });
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          const { definitions, writes, flows } = await parameterFixture(page);
          for (const definition of definitions)
            Object.assign(definition, { updated_at: definition.created_at });
          if (["flow-secret-only", "empty-flow-definition"].includes(state))
            definitions[2].env = {};
          if (state === "empty-flow-definition") definitions[2].secrets = [];
          await page.route("**/ui/v1/flows/7002", (route) =>
            route.fulfill({ json: flows[0] }),
          );
          const definition =
            state === "team"
              ? definitions[1]
              : ["flow", "flow-secret-only", "empty-flow-definition"].includes(
                    state,
                  )
                ? definitions[2]
                : definitions[0];
          const id = state === "unavailable" ? 9999 : definition.environment_id;
          let faultReads = 0;
          if (["loading", "error"].includes(state))
            await page.route(
              `**/ui/v1/teams/1/launch-parameters/${id}`,
              async (route) => {
                faultReads++;
                if (state === "loading") {
                  await held;
                  return route.fallback();
                }
                await route.fulfill({
                  status: 503,
                  json: { code: "unavailable" },
                });
              },
            );
          const reads: string[] = [];
          page.on("request", (request) => {
            if (
              request.method() === "GET" &&
              new URL(request.url()).pathname.includes("/launch-parameters")
            )
              reads.push(request.url());
          });
          await page.goto(`${proxy.baseUrl}?view=parameter&team=1&id=${id}`);
          const root = page.locator("#parameter-view");
          if (state === "loading") {
            await expect.poll(() => faultReads).toBe(1);
            await expect(root.getByRole("status")).toContainText(
              "Loading parameter definition…",
            );
            await expect(
              root.getByRole("heading", {
                name: "Definition identity",
                exact: true,
              }),
            ).toHaveCount(0);
          } else if (["error", "unavailable"].includes(state)) {
            if (state === "error")
              await expect(root.getByRole("alert")).toContainText(
                "Parameter definition could not be loaded",
              );
            else
              await expect(root.getByRole("status")).toContainText(
                "Parameter definition unavailable",
              );
            await expect(
              root.getByRole("link", {
                name: "Back to Parameters",
                exact: true,
              }),
            ).toBeVisible();
            if (state === "error") expect(faultReads).toBe(1);
            // Owner review 2026-10-25: no in-place Retry command.
            await expect(
              root.getByRole("button", { name: "Retry", exact: true }),
            ).toHaveCount(0);
            await expect(
              root.getByRole("heading", {
                name: "Definition identity",
                exact: true,
              }),
            ).toHaveCount(0);
            await expect(root).not.toContainText("global-value");
          } else {
            await expect(
              root.getByRole("heading", {
                name: "Definition identity",
                exact: true,
              }),
            ).toBeVisible();
            const identity = root.locator(".detail-grid > div").filter({
              has: page.getByText("Environment ID", { exact: true }),
            });
            await expect(identity.locator("dd")).toHaveText(String(id));
            await expect(
              root
                .locator(".detail-grid > div")
                .filter({ has: page.getByText("Scope", { exact: true }) })
                .locator("dd"),
            ).toHaveText(
              definition.scope === "global"
                ? "Global · read-only"
                : definition.scope === "team"
                  ? "Team"
                  : "Flow",
            );
            if (definition.scope === "global")
              expect(
                reads.some(
                  (value) =>
                    new URL(value).searchParams.get("scope") === "global",
                ),
              ).toBe(true);
            if (definition.scope === "flow")
              await expect(
                root.getByRole("link", { name: "Review flow", exact: true }),
              ).toHaveAttribute("href", "?view=flow&team=1&id=7002");
            for (const [key, value] of Object.entries(definition.env))
              await expect(
                root.locator("code").filter({ hasText: `${key}=${value}` }),
              ).toBeVisible();
            if (!Object.keys(definition.env).length)
              await expect(root).toContainText(
                definition.scope === "global"
                  ? "Ordinary valuesNone"
                  : "No ordinary values in this definition.",
              );
            if (definition.secrets.length) {
              await expect(root).toContainText("TOKEN");
              await expect(root).toContainText(
                "configured · Version 1 · value hidden",
              );
            } else
              await expect(root).toContainText(
                definition.scope === "global"
                  ? "Secret referencesNone"
                  : "No secret references in this definition.",
              );
          }
          await expect(root.locator("form,input,select,textarea")).toHaveCount(
            0,
          );
          expect(
            reads.some((value) =>
              /\/(revisions|secrets)(\/|$)/.test(new URL(value).pathname),
            ),
          ).toBe(false);
          expect(writes).toEqual([]);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await captureDesignState(
            page,
            test.info(),
            proxy.webUIImageID,
            `parameter-detail.html-${state}-${theme}-${width}`,
          );
          captures.push(state);
        } catch (error) {
          failures.push(error);
        } finally {
          release();
          try {
            await page.unrouteAll({ behavior: "wait" });
          } catch (error) {
            failures.push(error);
          }
          try {
            await page.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            `Parameter state ${state} or page cleanup failed`,
          );
      }
      await test.info().attach("approved-parameter-detail-states", {
        body: JSON.stringify({ theme, width, captures }),
        contentType: "application/json",
      });
    });
  }

// v0034.7 canonical Global inspection uses permitted exact collection reads
async function globalInspection(page: Page) {
  const { writes } = await parameterFixture(page);
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().includes("/launch-parameters")
    )
      reads.push(request.url());
  });
  await page.goto(`${proxy.baseUrl}?view=parameter&team=1&id=7041`);
  await expect(page.locator("#parameter-view")).toContainText("global-value");
  await expect(page.locator("#parameter-view")).toContainText(
    "Global · read-only",
  );
  expect(
    reads.some(
      (value) => new URL(value).searchParams.get("scope") === "global",
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.locator("#parameter-view")).toContainText("global-value");
  await page.goto(`${proxy.baseUrl}?view=parameter&team=1&id=9999`);
  await expect(page.locator("#parameter-view")).toContainText("unavailable");
  await expect(page.locator("#parameter-view")).not.toContainText(
    "global-value",
  );
  expect(
    reads.some((value) =>
      /\/revisions|\/secrets/.test(new URL(value).pathname),
    ),
  ).toBe(false);
  expect(writes).toEqual([]);
}

// v0034.10 late secret Versions cannot replace reopened parent Change history
async function lateSecretVersions(page: Page) {
  await parameterFixture(page);
  let release!: () => void,
    captured = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/launch-parameters/7043/secrets/7044/versions?**",
    async (route) => {
      captured = true;
      await held;
      await route.fulfill({
        json: {
          items: [{ version: 9, created_at: "2026-10-18T00:00:00Z" }],
          next_cursor: null,
        },
      });
    },
  );
  await page.route("**/launch-parameters/7042/revisions?**", (route) =>
    route.fulfill({
      json: {
        items: [{ revision: 2, created_at: "2026-10-18T00:00:00Z" }],
        next_cursor: null,
      },
    }),
  );
  try {
    await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
    await page
      .getByRole("button", { name: "Actions for TOKEN", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Versions", exact: true }).click();
    await expect.poll(() => captured).toBe(true);
    const history = page.locator("#history-dialog");
    await history.getByRole("button", { name: "Close", exact: true }).click();
    const team = page
      .locator("#definitions tr:visible,#definitions article:visible")
      .filter({
        has: page.locator(
          'a[data-catalog-view="parameter"][data-catalog-id="7042"]',
        ),
      });
    await team
      .getByRole("button", { name: "Actions for SHARED", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Change history", exact: true })
      .click();
    await expect(history).toContainText("Revision 2");
    const finished = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/7044/versions"),
    );
    release();
    await (await finished).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(history).toContainText("Revision 2");
    await expect(history).not.toContainText("Version 9");
  } finally {
    release();
  }
}

// v0034.7 full-definition deletion confirms the exact mixed definition and both kinds
async function fullDefinitionDeletion(page: Page) {
  const { writes } = await parameterFixture(page);
  await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
  await page
    .getByRole("button", { name: "Actions for TOKEN", exact: true })
    .click();
  page.on("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("menuitem", { name: "Delete parameters", exact: true })
    .click();
  const confirmation = page.locator("#parameter-delete-dialog");
  await expect(confirmation).toBeVisible();
  const text = (await confirmation.textContent()) || "";
  expect(text).toContain("Review defaults");
  expect(text).toContain("Review flow");
  expect(text).toMatch(/all its ordinary values/i);
  expect(text).toMatch(/secret/i);
  expect(text).toMatch(/history/i);
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(writes).toEqual([]);
}

// v0034.7 definition-limit fallback {enumerates complete exact Flow contexts, fails visibly without Flow enumeration}
async function definitionLimitFallback(page: Page, unavailable: boolean) {
  const { definitions, flows } = await parameterFixture(page);
  for (let index = 0; index < 100; index++) {
    const flow_id = 9300 + index;
    flows.push({ flow_id, name: `Extra flow ${index}` });
    definitions.push({
      environment_id: 9400 + index,
      scope: "flow",
      flow_id,
      name: `Extra definition ${index}`,
      revision: 1,
      created_at: new Date(Date.UTC(2026, 9, 19, 0, 0, index)).toISOString(),
      env: { [`EXTRA_${index}`]: `value-${index}` },
      secrets: [],
    });
  }
  if (unavailable)
    await page.route("**/ui/v1/flows?**", (route) =>
      route.fulfill({ status: 503, json: { code: "unavailable" } }),
    );
  const queries: URL[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().includes("/launch-parameters?")
    )
      queries.push(new URL(request.url()));
  });
  await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
  if (unavailable) {
    await expect(page.locator("#definitions [role=alert]")).toContainText(
      "Request failed",
    );
    await expect(page.locator("#definitions .pager")).toHaveCount(0);
    return;
  }
  await expect(page.locator("#definitions .pager")).toContainText(
    "104 entries",
  );
  await page
    .locator("#app")
    .getByRole("combobox", { name: "Rows per page", exact: true })
    .selectOption("100");
  const links = page.locator(
    '#definitions a[data-catalog-view="parameter"]:visible',
  );
  await expect(links).toHaveCount(100);
  const identities = async () =>
    links.evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          `${(node as HTMLAnchorElement).dataset.catalogId}/${node.textContent}`,
      ),
    );
  const first = await identities();
  await page
    .locator("#definitions")
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(links).toHaveCount(4);
  expect(new Set([...first, ...(await identities())]).size).toBe(104);
  expect(queries.filter((url) => url.searchParams.has("flow_id"))).toHaveLength(
    3,
  );
  expect(
    new Set(
      queries
        .filter((url) => url.searchParams.has("flow_id"))
        .map((url) => url.searchParams.get("flow_id")),
    ).size,
  ).toBe(3);
}

// v0034.7 Parameters menu keyboard, viewport and Global read-only guards
async function menuGuards(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes } = await parameterFixture(page);
  await page.goto(`${proxy.baseUrl}?view=parameters&team=1`);
  await expect(
    page.locator('.nav-links [data-view="settings"]'),
  ).toHaveAttribute("aria-current", "page");
  const plus = page.getByRole("button", {
    name: "Create parameter",
    exact: true,
  });
  await plus.focus();
  await plus.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Add variable", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Add secret", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(plus).toBeFocused();
  await expect(plus).toHaveAttribute("aria-expanded", "false");
  const trigger = page.getByRole("button", {
    name: "Actions for TOKEN",
    exact: true,
  });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.evaluate((element) => {
    scrollBy(0, element.getBoundingClientRect().bottom - innerHeight + 8);
  });
  const triggerBottom = await trigger.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  );
  await trigger.click();
  const menu = page.getByRole("menu", {
    name: "Actions for TOKEN",
    exact: true,
  });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  const { width, height } = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect(triggerBottom).toBeLessThanOrEqual(height);
  expect(height - triggerBottom).toBeLessThan(bounds!.height);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
  await menu.getByRole("menuitem", { name: "Versions", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByRole("link", { name: "SHARED", exact: true }).first().click();
  await expect(
    page.getByRole("heading", { name: "Parameter definition", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe("7041");
  await expect(page.locator("#parameter-view")).toContainText("global-value");
  await expect(page.locator("#parameter-view")).toContainText(
    "Global · read-only",
  );
  await expect(
    page.locator(
      "#parameter-view input,#parameter-view select,#parameter-view button",
    ),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
}

// v0034.7 one entry pager covers both kinds and scope survives definition inspection
async function entryPager(page: Page) {
  const { definitions } = await parameterFixture(page);
  for (const definition of definitions)
    definition.env = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `${definition.scope.toUpperCase()}_${i}`,
        `${definition.scope}-value-${i}`,
      ]),
    );
  await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
  const links = page.locator(
    '#definitions a[data-catalog-view="parameter"]:visible',
  );
  await expect(links).toHaveCount(10);
  await expect(page.locator("#definitions .pager")).toContainText(
    "16 entries · Page 1 of 2",
  );
  const first = await links.allTextContents();
  await page
    .locator("#definitions")
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(links).toHaveCount(6);
  expect(new Set([...first, ...(await links.allTextContents())]).size).toBe(16);
  await page
    .locator("#app")
    .getByRole("combobox", { name: "Scope", exact: true })
    .selectOption("team");
  await expect(links).toHaveCount(5);
  await expect(page.locator("#definitions .pager")).toContainText(
    "5 entries · Page 1 of 1",
  );
  expect(new URL(page.url()).searchParams.get("scope")).toBe("team");
  await page.reload();
  await expect(
    page.locator("#app").getByRole("combobox", { name: "Scope", exact: true }),
  ).toHaveValue("team");
  await expect(links).toHaveCount(5);
  await links.first().click();
  await expect(
    page.getByRole("heading", { name: "Parameter definition", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe("7042");
  await expect(page.locator("#parameter-view")).toContainText("team-value-0");
  await page
    .getByRole("link", { name: "Back to Parameters", exact: true })
    .click();
  await expect(
    page.locator("#app").getByRole("combobox", { name: "Scope", exact: true }),
  ).toHaveValue("team");
  await expect(links).toHaveCount(5);
}

// v0034.7 empty definitions retain exact deletion without an invented revision precondition
async function emptyDefinitions(page: Page) {
  const { definitions, writes } = await parameterFixture(page);
  for (const definition of definitions) definition.env = {};
  await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
  await expect(page.locator("#definitions .pager")).toContainText(
    "1 of 1 entries",
  );
  const empty = page.locator(".parameter-empty-context").filter({
    has: page.getByRole("link", { name: "Team defaults", exact: true }),
  });
  await expect(empty).toBeVisible();
  await empty
    .getByRole("button", { name: "Actions for Team defaults", exact: true })
    .click();
  page.on("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("menuitem", { name: "Delete parameters", exact: true })
    .click();
  const confirmation = page.locator("#parameter-delete-dialog");
  await expect(confirmation).toContainText("Team defaults");
  await confirmation
    .getByRole("button", { name: "Delete parameters", exact: true })
    .click();
  await expect(empty).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    method: "DELETE",
    path: "/ui/v1/teams/1/launch-parameters/7042",
    body: null,
  });
  expect(writes[0].headers["if-match"]).toBeUndefined();
  await expect(
    page.getByRole("link", { name: "TOKEN", exact: true }),
  ).toBeVisible();
}

// v0034.7 no writable definition supplies no implicit secret target
async function noWritableDefinition(page: Page) {
  const { definitions, writes } = await parameterFixture(page);
  definitions.splice(1);
  await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
  await expect(
    page.getByRole("link", { name: "SHARED", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create parameter", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Add secret", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Add variable", exact: true }),
  ).toBeEnabled();
  expect(writes).toEqual([]);
}

// v0034.10 a late secret create cannot clear or close a replacement dialog
async function lateSecretCreate(page: Page) {
  await parameterFixture(page);
  let release!: () => void,
    captured = false,
    writes = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/launch-parameters/7043/secrets", async (route) => {
    writes++;
    captured = true;
    await held;
    await route.fulfill({
      status: 201,
      json: { secret_id: 7001, name: "FIRST", latest_version: 1 },
    });
  });
  const open = async () => {
    await page
      .getByRole("button", { name: "Create parameter", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Add secret", exact: true })
      .click();
  };
  try {
    await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
    await open();
    const dialog = page.locator("#secret-dialog");
    await dialog
      .getByLabel("Target definition", { exact: true })
      .selectOption("7043");
    await dialog.getByLabel("Key name", { exact: true }).fill("FIRST");
    await dialog
      .getByLabel("New secret value", { exact: true })
      .fill("synthetic-old-request");
    await dialog
      .getByRole("button", { name: "Save secret", exact: true })
      .click();
    await expect.poll(() => captured).toBe(true);
    await expect(
      dialog.getByLabel("New secret value", { exact: true }),
    ).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Save secret", exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole("button", { name: "Save secret", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    expect(writes).toBe(1);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await open();
    await dialog
      .getByLabel("Target definition", { exact: true })
      .selectOption("7042");
    await dialog.getByLabel("Key name", { exact: true }).fill("SECOND");
    await dialog
      .getByLabel("New secret value", { exact: true })
      .fill("synthetic-new-draft");
    const finished = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/7043/secrets"),
    );
    release();
    await (await finished).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByLabel("Target definition", { exact: true }),
    ).toHaveValue("7042");
    await expect(dialog.getByLabel("Key name", { exact: true })).toHaveValue(
      "SECOND",
    );
    await expect(
      dialog.getByLabel("New secret value", { exact: true }),
    ).toHaveValue("synthetic-new-draft");
    expect(writes).toBe(1);
  } finally {
    release();
  }
}

// v0034.12 Parameter deletion {variable,secret,definition} {theme} {width}
async function parameterDeletion(
  page: Page,
  kind: string,
  theme: string,
  width: number,
) {
  page.on("dialog", (dialog) => dialog.dismiss());
  {
    await page.setViewportSize({
      width,
      height: width === 390 ? 844 : width === 820 ? 1180 : 900,
    });
    await page.addInitScript(
      (value) => localStorage.setItem("flowai.theme", value),
      theme,
    );
    const { writes } = await parameterFixture(page);
    await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
    const row = page
      .locator("#definitions tr:visible,#definitions article:visible")
      .filter({
        has: page.locator(
          'a[data-catalog-view="parameter"][data-catalog-id="7043"]',
        ),
      })
      .filter({
        has: page.getByRole("button", {
          name:
            kind === "variable" ? "Actions for SHARED" : "Actions for TOKEN",
          exact: true,
        }),
      });
    const open = async () => {
      await row
        .getByRole("button", {
          name:
            kind === "variable" ? "Actions for SHARED" : "Actions for TOKEN",
          exact: true,
        })
        .click();
      await page
        .getByRole("menuitem", {
          name: kind === "definition" ? "Delete parameters" : `Delete ${kind}`,
          exact: true,
        })
        .click();
    };
    await open();
    const dialog = page.locator("#parameter-delete-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Review defaults");
    await expect(dialog).toContainText("Review flow");
    await expect(dialog).toContainText("7043");
    await expect(dialog).toContainText(/history/i);
    await expect(dialog).not.toContainText("flow-value");
    // Capture the resting confirmation, not the hover left by the
    // menu click that opened it.
    await page.mouse.move(0, 0);
    await captureDesignState(
      page,
      test.info(),
      proxy.webUIImageID,
      `environments.html-delete-${kind === "definition" ? "parameters" : kind}-${theme}-${width}`,
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(writes).toEqual([]);
    const attempts: { method: string; pathname: string; body: any }[] = [];
    await page.route("**/ui/v1/teams/1/launch-parameters/**", (route) => {
      if (route.request().method() === "GET") return route.fallback();
      attempts.push({
        method: route.request().method(),
        pathname: new URL(route.request().url()).pathname,
        body: route.request().postData()
          ? route.request().postDataJSON()
          : null,
      });
      return route.fulfill({
        status: 503,
        json: { code: "unavailable" },
      });
    });
    await open();
    await dialog
      .getByRole("button", { name: deleteAction(kind), exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "could not be confirmed",
    );
    await expect(
      dialog.getByRole("button", {
        name: deleteAction(kind),
        exact: true,
      }),
    ).toBeDisabled();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      method: kind === "variable" ? "PUT" : "DELETE",
      pathname: `/ui/v1/teams/1/launch-parameters/7043${kind === "secret" ? "/secrets/7044" : ""}`,
    });
    if (kind === "variable")
      expect(attempts[0].body).toEqual({
        scope: "flow",
        flow_id: 7002,
        name: "Review defaults",
        env: {},
      });
    else expect(attempts[0].body).toBeNull();
    await captureDesignState(
      page,
      test.info(),
      proxy.webUIImageID,
      `parameter-delete-${kind}-unconfirmed-${theme}-${width}`,
    );
    await dialog
      .getByRole("button", { name: "Reload collection", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toBeVisible();
    expect(attempts).toHaveLength(1);
    expect(writes).toEqual([]);
  }
}

// v0034.10 Parameter deletion {variable,secret,definition} prevents duplicate dispatch while held and releases after rejection
async function heldDeletion(page: Page, kind: string) {
  const { definitions } = await parameterFixture(page);
  const key = kind === "variable" ? "SHARED" : "TOKEN";
  const row = page
    .locator("#definitions tr:visible,#definitions article:visible")
    .filter({
      has: page.locator(
        'a[data-catalog-view="parameter"][data-catalog-id="7043"]',
      ),
    })
    .filter({
      has: page.getByRole("button", {
        name: `Actions for ${key}`,
        exact: true,
      }),
    });
  const open = async () => {
    await row
      .getByRole("button", { name: `Actions for ${key}`, exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: kind === "definition" ? "Delete parameters" : `Delete ${kind}`,
        exact: true,
      })
      .click();
  };
  const requests: { method: string; pathname: string; body: any }[] = [];
  const expected = {
    method: kind === "variable" ? "PUT" : "DELETE",
    pathname: `/ui/v1/teams/1/launch-parameters/7043${kind === "secret" ? "/secrets/7044" : ""}`,
    body:
      kind === "variable"
        ? {
            scope: "flow",
            flow_id: 7002,
            name: "Review defaults",
            env: {},
          }
        : null,
  };
  let release!: () => void,
    calls = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ui/v1/teams/1/launch-parameters/**", async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    const actual = {
      method: route.request().method(),
      pathname: new URL(route.request().url()).pathname,
      body: route.request().postData() ? route.request().postDataJSON() : null,
    };
    requests.push(actual);
    calls++;
    if (
      actual.method !== expected.method ||
      actual.pathname !== expected.pathname ||
      (kind === "variable"
        ? actual.body?.scope !== "flow" ||
          actual.body?.flow_id !== 7002 ||
          actual.body?.name !== "Review defaults" ||
          !actual.body?.env ||
          Object.keys(actual.body.env).length !== 0
        : actual.body !== null)
    )
      return route.fulfill({
        status: 422,
        json: { code: "wrong_fixture_mutation" },
      });
    if (calls === 1) {
      await held;
      return route.fulfill({ status: 503, json: { code: "unavailable" } });
    }
    const definition = definitions.find(
      (item) => item.environment_id === 7043,
    )!;
    if (kind === "variable")
      definition.env = route.request().postDataJSON().env;
    else if (kind === "secret") definition.secrets = [];
    else definitions.splice(definitions.indexOf(definition), 1);
    return kind === "variable"
      ? route.fulfill({ status: 200, json: definition })
      : route.fulfill({ status: 204 });
  });
  try {
    await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
    await open();
    const dialog = page.locator("#parameter-delete-dialog[open]");
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await dialog
      .getByRole("button", { name: deleteAction(kind), exact: true })
      .click();
    await expect.poll(() => calls).toBe(1);
    await expect(
      dialog.getByRole("button", { name: deleteAction(kind), exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.locator("form").evaluate((form) => {
      for (let index = 0; index < 2; index++)
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(calls).toBe(1);
    release();
    await expect(dialog.getByRole("alert")).toContainText(
      "could not be confirmed",
    );
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      row.getByRole("button", { name: `Actions for ${key}`, exact: true }),
    ).toBeFocused();
    await open();
    await dialog
      .getByRole("button", { name: deleteAction(kind), exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => calls).toBe(2);
    expect(requests).toEqual([expected, expected]);
    const links = page.locator(
      `#definitions a[data-catalog-view="parameter"][data-catalog-id="7043"]:visible`,
    );
    if (kind === "definition") await expect(links).toHaveCount(0);
    else {
      await expect(links).toHaveCount(1);
      await expect(links).toHaveText(kind === "variable" ? "TOKEN" : "SHARED");
    }
  } finally {
    // The page's routes are removed by runSteps after this release.
    release();
  }
}

for (const theme of ["dark", "light"] as const)
  for (const [width, height] of [
    [390, 844],
    [820, 1180],
    [1440, 900],
  ])
    test(`v0034.12 complete Parameters collection presentation states ${theme} ${width}`, async ({
      browser,
    }, info) => {
      test.setTimeout(240_000);
      const failures: unknown[] = [];
      for (const state of [
        "default",
        "add-variable",
        "edit-variable",
        "add-secret",
        "replace-secret",
        "delete-variable",
        "change-history",
        "versions",
        "invalid-key",
        "no-results",
        "loading",
        "error",
        "delete-secret",
        "delete-parameters",
        "global-readonly",
        "no-writable-definitions",
        "general-only",
        "flow-only",
        "mixed",
        "empty",
        "flow-secret-versions",
        "flow-secret-replace",
        "empty-flow-definition",
        "flow-secret-only",
      ]) {
        const context = await browser.newContext({
            viewport: { width, height },
          }),
          page = await context.newPage();
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached = 0;
        try {
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          const { definitions, writes } = await parameterFixture(page);
          const flow = definitions.find((row) => row.scope === "flow")!;
          if (["global-readonly", "no-writable-definitions"].includes(state))
            definitions.splice(1);
          if (["general-only", "no-results"].includes(state))
            definitions.splice(2);
          if (state === "flow-only") definitions.splice(0, 2);
          if (state === "empty") definitions.splice(0);
          if (["empty-flow-definition", "flow-secret-only"].includes(state)) {
            flow.env = {};
            if (state === "empty-flow-definition") flow.secrets = [];
          }
          if (["loading", "error"].includes(state))
            await page.route(
              "**/ui/v1/teams/1/launch-parameters?**",
              async (route) => {
                reached++;
                if (state === "loading") await held;
                await route.fulfill({
                  status: 503,
                  json: { code: "temporarily_unavailable" },
                });
              },
            );
          await page.goto(
            `${proxy.baseUrl}?view=settings&section=parameters&team=1${state === "no-results" ? "&scope=flow" : ""}`,
          );
          const root = page.locator("#definitions");
          if (["loading", "error"].includes(state)) {
            await expect.poll(() => reached).toBeGreaterThan(0);
            await expect(root).toContainText(
              state === "loading"
                ? /loading/i
                : /failed|unavailable|could not/i,
            );
          } else {
            await expect(root).not.toBeEmpty();
            if (
              [
                "add-variable",
                "add-secret",
                "invalid-key",
                "no-writable-definitions",
              ].includes(state)
            ) {
              await page
                .getByRole("button", { name: "Create parameter", exact: true })
                .click();
              if (state === "no-writable-definitions") {
                await expect(
                  page.getByRole("menuitem", {
                    name: "Add secret",
                    exact: true,
                  }),
                ).toBeDisabled();
                await page.keyboard.press("Escape");
                await expect(page.getByRole("menu")).toHaveCount(0);
                // Capture the resting create entry, not its hover state.
                await page.mouse.move(0, 0);
              } else {
                await page
                  .getByRole("menuitem", {
                    name:
                      state === "add-secret" ? "Add secret" : "Add variable",
                    exact: true,
                  })
                  .click();
                const dialog = page.locator(
                  state === "add-secret" ? "#secret-dialog" : "#env-dialog",
                );
                await expect(dialog).toBeVisible();
                if (state === "invalid-key") {
                  await dialog
                    .getByLabel("Key name", { exact: true })
                    .fill("invalid-key");
                  await dialog
                    .getByLabel("Value", { exact: true })
                    .fill("ordinary value");
                  await dialog
                    .getByRole("button", {
                      name:
                        state === "add-secret"
                          ? "Save secret"
                          : "Save variable",
                      exact: true,
                    })
                    .click();
                  expect(
                    await dialog
                      .locator('[name="key"]')
                      .evaluate(
                        (element: HTMLInputElement) => element.validity.valid,
                      ),
                  ).toBe(false);
                }
              }
            } else {
              const command: Record<string, string> = {
                "edit-variable": "Edit variable",
                "replace-secret": "Replace secret",
                "delete-variable": "Delete variable",
                "change-history": "Change history",
                versions: "Versions",
                "delete-secret": "Delete secret",
                "delete-parameters": "Delete parameters",
                "flow-secret-versions": "Versions",
                "flow-secret-replace": "Replace secret",
              };
              if (command[state]) {
                const secret = state.includes("secret") || state === "versions";
                const key = secret ? "TOKEN" : "SHARED";
                const row = root
                  .locator("tr:visible,article:visible")
                  .filter({
                    has: page.locator('a[data-catalog-id="7043"]'),
                  })
                  .filter({
                    has: page.getByRole("button", {
                      name: `Actions for ${key}`,
                      exact: true,
                    }),
                  });
                await row
                  .getByRole("button", {
                    name: `Actions for ${key}`,
                    exact: true,
                  })
                  .click();
                await page
                  .getByRole("menuitem", { name: command[state], exact: true })
                  .click();
                await expect(page.locator("dialog[open]")).toHaveCount(1);
                if (
                  command[state] === "Versions" ||
                  command[state] === "Change history"
                )
                  await expect(page.locator("#history-dialog")).toContainText(
                    /1|3/,
                  );
              } else if (["empty", "no-results"].includes(state))
                await expect(root).toContainText(/no.*(parameter|entr)/i);
              else if (state === "global-readonly")
                await expect(
                  root.getByRole("button", { name: /Actions for/ }),
                ).toHaveCount(0);
              else if (state === "empty-flow-definition")
                await expect(
                  root.locator(".parameter-empty-context"),
                ).toContainText("Review defaults");
              else
                await expect(
                  root
                    .locator('a[data-catalog-view="parameter"]:visible')
                    .first(),
                ).toBeVisible();
            }
          }
          expect(writes).toEqual([]);
          // Capture resting commands, not the hover left by the last click.
          await page.mouse.move(0, 0);
          await captureDesignState(
            page,
            info,
            proxy.webUIImageID,
            `environments.html-${state}-${theme}-${width}`,
          );
        } catch (error) {
          failures.push(error);
          await info.attach(`parameters-${state}-failure`, {
            body: String(error),
            contentType: "text/plain",
          });
        } finally {
          release();
          await context.close();
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Parameters presentation batch");
    });

// Owner decision 2026-11-02: checks that share their setup run as steps of
// one test. Each step gets a fresh page (fresh parameterFixture state), its
// routes are drained and the page closed before the next step, and every
// step runs before the test fails.
async function runSteps(
  context: BrowserContext,
  steps: [string, (page: Page) => Promise<void>][],
) {
  const failures: unknown[] = [];
  for (const [title, body] of steps) {
    try {
      await test.step(title, async () => {
        const page = await context.newPage();
        const errors: unknown[] = [];
        try {
          await body(page);
        } catch (error) {
          errors.push(error);
        }
        try {
          await page.unrouteAll({ behavior: "wait" });
          await page.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw new AggregateError(
            errors,
            `${title}: check and release failed`,
          );
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} steps failed`);
}

const kinds = ["variable", "secret", "definition"];

test("v0034.7 Parameters read-only guards, deletion confirmation and menus", async ({
  context,
}) => {
  test.setTimeout(4 * 30_000);
  await runSteps(context, [
    [
      "v0034.7 canonical Global inspection uses permitted exact collection reads",
      globalInspection,
    ],
    [
      "v0034.7 full-definition deletion confirms the exact mixed definition and both kinds",
      fullDefinitionDeletion,
    ],
    [
      "v0034.7 no writable definition supplies no implicit secret target",
      noWritableDefinition,
    ],
    [
      "v0034.7 Parameters menu keyboard, viewport and Global read-only guards",
      menuGuards,
    ],
  ]);
});

test("v0034.7 Parameters pager, scope, definition-limit fallback and empty-definition deletion", async ({
  context,
}) => {
  test.setTimeout(4 * 30_000);
  await runSteps(context, [
    [
      "v0034.7 definition-limit fallback enumerates complete exact Flow contexts",
      (page) => definitionLimitFallback(page, false),
    ],
    [
      "v0034.7 definition-limit fallback fails visibly without Flow enumeration",
      (page) => definitionLimitFallback(page, true),
    ],
    [
      "v0034.7 one entry pager covers both kinds and scope survives definition inspection",
      entryPager,
    ],
    [
      "v0034.7 empty definitions retain exact deletion without an invented revision precondition",
      emptyDefinitions,
    ],
  ]);
});

test("v0034.10 late secret responses cannot replace reopened dialogs", async ({
  context,
}) => {
  test.setTimeout(2 * 30_000);
  await runSteps(context, [
    [
      "v0034.10 late secret Versions cannot replace reopened parent Change history",
      lateSecretVersions,
    ],
    [
      "v0034.10 a late secret create cannot clear or close a replacement dialog",
      lateSecretCreate,
    ],
  ]);
});

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.12 Parameter deletion confirmations (variable, secret, definition) ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout(kinds.length * 30_000);
      await runSteps(
        context,
        kinds.map((kind): [string, (page: Page) => Promise<void>] => [
          `v0034.12 Parameter deletion ${kind} ${theme} ${width}`,
          (page) => parameterDeletion(page, kind, theme, width),
        ]),
      );
    });

test("v0034.10 Parameter deletion of every kind prevents duplicate dispatch while held", async ({
  context,
}) => {
  test.setTimeout(kinds.length * 30_000);
  await runSteps(
    context,
    kinds.map((kind): [string, (page: Page) => Promise<void>] => [
      `v0034.10 Parameter deletion ${kind} prevents duplicate dispatch while held and releases after rejection`,
      (page) => heldDeletion(page, kind),
    ]),
  );
});
