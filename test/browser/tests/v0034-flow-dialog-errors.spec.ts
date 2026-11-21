import { captureDesignState } from "../fixtures/design-capture";
import {
  cancelFlow,
  createFlowEntry,
  flowEditor,
} from "../fixtures/flow-editor";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import {
  flowFixture,
  flowID,
  secondFlowID,
  aliases,
} from "../fixtures/v0034-flow";

// Fail missing-control actions before the test deadline, leaving teardown time.
test.use({ actionTimeout: 10_000 });

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

type Step = [string, (page: Page) => Promise<void>];
// A merged test runs every step (one per original check) on its own fresh
// page, keeps each step's own final capture, then fails with all errors.
async function runPageSteps(context: BrowserContext, steps: Step[]) {
  const failures: unknown[] = [];
  for (const [title, body] of steps)
    await test.step(title, async () => {
      const page = await context.newPage();
      try {
        await body(page);
      } catch (error) {
        failures.push(error);
      }
      try {
        await captureDesignState(
          page,
          test.info(),
          proxy.webUIImageID,
          `final-${title}`,
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        await page.unrouteAll({ behavior: "wait" });
        await page.close();
      } catch (error) {
        failures.push(error);
      }
    });
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} steps failed`);
}

// The approved standalone Flow editor page (create and edit).
const editor = flowEditor;
const openOther = async (page: import("@playwright/test").Page) => {
  await page
    .locator("#flows-results dl.data-card:visible")
    .filter({
      has: page.getByRole("link", { name: "Other flow", exact: true }),
    })
    .getByRole("button", { name: "Actions for Other flow", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit flow", exact: true }).click();
  await expect(editor(page).getByLabel("Name", { exact: true })).toHaveValue(
    "Other flow",
  );
};

const olderOpen = async (page: Page) => {
  const { flows, writes } = await flowFixture(page, true);
  let release!: () => void,
    captured = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/ui/v1/flows/${flowID}`, async (route) => {
    captured = true;
    await held;
    await route.fulfill({ json: flows.get(flowID), headers: { etag: '"1"' } });
  });
  try {
    await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
    await expect.poll(() => captured).toBe(true);
    await page.keyboard.press("Escape");
    await openOther(page);
    await editor(page)
      .getByLabel("Name", { exact: true })
      .fill("Newer safe draft");
    const finished = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/ui/v1/flows/${flowID}`,
    );
    release();
    await (await finished).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(editor(page).getByLabel("Name", { exact: true })).toHaveValue(
      "Newer safe draft",
    );
    await expect(editor(page).getByLabel("Model", { exact: true })).toHaveValue(
      aliases[2],
    );
    expect(writes).toEqual([]);
  } finally {
    release();
  }
};

const saveScenarios = ["pending gate", "late success", "late error"] as const;
{
  const olderSave = async (
    page: Page,
    scenario: (typeof saveScenarios)[number],
  ) => {
    const { flows, writes } = await flowFixture(page, true);
    let release!: () => void,
      captured = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/ui/v1/flows/${flowID}`, async (route) => {
      if (route.request().method() === "PUT") {
        captured = true;
        await held;
        return route.fulfill(
          scenario === "late error"
            ? { status: 412, json: { code: "revision_mismatch" } }
            : {
                json: {
                  ...flows.get(flowID),
                  ...route.request().postDataJSON(),
                  revision: 2,
                },
                headers: { etag: '"2"' },
              },
        );
      }
      return route.fulfill({
        json: flows.get(flowID),
        headers: { etag: '"1"' },
      });
    });
    try {
      await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
      await expect(
        editor(page).getByLabel("Name", { exact: true }),
      ).toHaveValue("Order flow");
      await editor(page)
        .getByLabel("Name", { exact: true })
        .fill("Older write");
      await editor(page)
        .getByRole("button", { name: "Save flow", exact: true })
        .click();
      await expect.poll(() => captured).toBe(true);
      await cancelFlow(editor(page)).click();
      await openOther(page);
      await editor(page)
        .getByLabel("Name", { exact: true })
        .fill("Newer safe draft");
      if (scenario === "pending gate")
        await expect(
          editor(page).getByRole("button", { name: "Save flow", exact: true }),
        ).toBeEnabled();
      const finished = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === `/ui/v1/flows/${flowID}`,
      );
      release();
      await (await finished).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(editor(page)).toBeVisible();
      await expect(
        editor(page).getByLabel("Name", { exact: true }),
      ).toHaveValue("Newer safe draft");
      await expect(editor(page).getByRole("alert")).toHaveText("");
      await expect(
        editor(page).getByRole("button", { name: "Save flow", exact: true }),
      ).toBeEnabled();
      expect(writes).toHaveLength(1);
      expect(writes[0].path).toBe(`/ui/v1/flows/${flowID}`);
      expect(writes[0].path).not.toBe(`/ui/v1/flows/${secondFlowID}`);
    } finally {
      release();
    }
  };
  test("v0034.10 older Flow open and Save responses cannot replace a reopened editor", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    await runPageSteps(context, [
      [
        "v0034.10 an older Flow open cannot overwrite the newer dialog identity or draft",
        olderOpen,
      ],
      ...saveScenarios.map(
        (scenario) =>
          [
            `v0034.10 older Flow Save ${scenario} cannot gate or replace a reopened editor`,
            (page: Page) => olderSave(page, scenario),
          ] as Step,
      ),
    ]);
  });
}

const settleFlowReads = async (page: import("@playwright/test").Page) => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
};

const makeStale = async (page: import("@playwright/test").Page) => {
  await page.route(`**/ui/v1/flows/${flowID}`, async (route) => {
    if (route.request().method() === "PUT")
      return route.fulfill({
        status: 412,
        json: { code: "revision_mismatch" },
      });
    await route.fallback();
  });
  await editor(page)
    .getByLabel("Name", { exact: true })
    .fill("Keep this safe draft");
  await editor(page)
    .getByRole("button", { name: "Save flow", exact: true })
    .click();
  await expect(editor(page).getByRole("alert")).toContainText(
    "Reload the current resource",
  );
};

const cancelDuringReload = async (page: Page) => {
  await flowFixture(page);
  await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
  await expect(editor(page).getByLabel("Name", { exact: true })).toHaveValue(
    "Order flow",
  );
  await makeStale(page);
  let captured = false,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ui/v1/models?**", async (route) => {
    captured = true;
    await held;
    await route.fallback();
  });
  try {
    await editor(page)
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await expect.poll(() => captured).toBe(true);
    await cancelFlow(editor(page)).click();
    await expect(editor(page)).not.toBeVisible();
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/ui/v1/models",
    );
    release();
    await (await response).finished();
    await settleFlowReads(page);
    await expect(editor(page)).not.toBeVisible();
    await page
      .locator("#flows-results")
      .getByRole("link", { name: "Order flow", exact: true })
      .first()
      .click();
    await expect(page.locator("h1")).toHaveText("Flow detail");
  } finally {
    release();
  }
};

const failingOperations = ["open", "Reload", "Preview"] as const;
{
  const networkFailure = async (
    page: Page,
    operation: (typeof failingOperations)[number],
  ) => {
    const { writes } = await flowFixture(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (operation === "open") {
      await page.route(`**/ui/v1/flows/${flowID}`, (route) =>
        route.abort("failed"),
      );
      await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
    } else {
      await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
      await expect(
        editor(page).getByLabel("Name", { exact: true }),
      ).toHaveValue("Order flow");
      if (operation === "Reload") await makeStale(page);
      await editor(page)
        .getByLabel("Name", { exact: true })
        .fill("Keep this safe draft");
      await page.route(
        operation === "Reload"
          ? `**/ui/v1/flows/${flowID}`
          : "**/ui/v1/flows/preview",
        (route) => route.abort("failed"),
      );
      await editor(page)
        .getByRole("button", {
          name: operation === "Preview" ? "Preview prompt" : operation,
          exact: true,
        })
        .click();
    }
    const feedback =
      operation === "Preview"
        ? editor(page).locator("[data-prompt-preview]")
        : editor(page).getByRole("alert");
    await expect(feedback).toContainText(
      /could not|unavailable|try again|request failed|check the connection/i,
    );
    expect(errors).toEqual([]);
    if (operation !== "open")
      await expect(
        editor(page).getByLabel("Name", { exact: true }),
      ).toHaveValue("Keep this safe draft");
    if (operation === "Preview") {
      await page.unroute("**/ui/v1/flows/preview");
      await page.route("**/ui/v1/flows/preview", (route) =>
        route.fulfill({ json: { rendered_prompt: "Recovered preview" } }),
      );
      await editor(page)
        .getByRole("button", { name: "Preview prompt", exact: true })
        .click();
      await expect(feedback).toHaveText("Recovered preview");
    } else {
      await page.unroute(`**/ui/v1/flows/${flowID}`);
      await page.route(`**/ui/v1/flows/${flowID}`, (route) =>
        route.fulfill({
          json: {
            flow_id: flowID,
            name: "Order flow",
            execution_tag: "openhands",
            model_aliases: aliases.slice(0, 3),
            source_ids: [],
            source_revisions: {},
            prompt_template: "Work",
          },
          headers: { etag: '"2"' },
        }),
      );
      await editor(page)
        .getByRole("button", { name: "Reload", exact: true })
        .click();
      await expect(
        editor(page).getByLabel("Name", { exact: true }),
      ).toHaveValue("Order flow");
      await expect(editor(page).getByRole("alert")).toHaveText("");
    }
    expect(writes.map((write) => write.path)).toEqual(
      operation === "open"
        ? []
        : operation === "Reload"
          ? [`/ui/v1/flows/${flowID}`]
          : ["/ui/v1/flows/preview", "/ui/v1/flows/preview"],
    );
  };
  test("v0034.10 Flow open, Reload and Preview network failures are recoverable", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    await runPageSteps(
      context,
      failingOperations.map((operation) => [
        `v0034.10 Flow ${operation} network failure is recoverable and keeps safe drafts`,
        (page: Page) => networkFailure(page, operation),
      ]),
    );
  });
}

const pendingReload = async (page: Page) => {
  await flowFixture(page);
  await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
  await expect(editor(page).getByLabel("Name", { exact: true })).toHaveValue(
    "Order flow",
  );
  await makeStale(page);
  let captured = false,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ui/v1/models?**", async (route) => {
    captured = true;
    await held;
    await route.fallback();
  });
  try {
    await editor(page)
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await expect.poll(() => captured).toBe(true);
    await expect(editor(page).getByRole("status")).toContainText("Loading…");
    await expect(
      editor(page).getByLabel("Name", { exact: true }),
    ).toBeDisabled();
    await expect(
      editor(page).getByRole("button", { name: "Save flow", exact: true }),
    ).toBeDisabled();
    release();
    await expect(
      editor(page).getByLabel("Name", { exact: true }),
    ).toBeEnabled();
    await expect(editor(page).getByLabel("Name", { exact: true })).toHaveValue(
      "Order flow",
    );
    await expect(editor(page).getByRole("status")).toHaveText("");
  } finally {
    release();
  }
};

test("v0034.10 pending Reload: loading guard and cancellation", async ({
  context,
}) => {
  test.setTimeout(60_000);
  await runPageSteps(context, [
    [
      "v0034.10 cancelling during Reload catalog reads cannot reopen the editor",
      cancelDuringReload,
    ],
    [
      "v0034.10 pending Reload exposes loading and prevents an overwriteable new draft",
      pendingReload,
    ],
  ]);
});

// Retained screenshots complement behavior assertions; they are not a full visual verdict.
test.afterEach(async ({ page }, info) => {
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    `final-${info.title}`,
  );
});

for (const theme of ["dark", "light"] as const)
  for (const [width, height] of [
    [390, 844],
    [820, 1180],
    [1440, 900],
  ])
    test(`v0034.12 complete Flow editor presentation states ${theme} ${width}`, async ({
      browser,
    }, info) => {
      test.setTimeout(240_000);
      const failures: unknown[] = [];
      const states = [
        "default",
        "create",
        "edit",
        "source-schema-absent",
        "source-schema-incomplete",
        "source-schema-complete",
        "shared-warning",
        "validation",
        "busy",
        "revision-412",
        "model-503",
        "loading",
        "error",
      ];
      for (const state of states) {
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
          const { flows, writes } = await flowFixture(page);
          const sourceStatus =
            state === "source-schema-absent"
              ? "awaiting_schema"
              : state === "source-schema-incomplete"
                ? "incomplete"
                : "complete";
          if (state.startsWith("source-schema") || state === "shared-warning") {
            const source = {
              source_id: 7031,
              name: "Shared Source",
              revision: 1,
              mode: "webhook",
              settings_status: sourceStatus,
            };
            await page.route("**/ui/v1/sources?**", (route) =>
              route.fulfill({ json: { items: [source], next_cursor: null } }),
            );
            Object.assign(flows.get(flowID)!, {
              source_ids: [source.source_id],
              source_revisions: { [source.source_id]: 1 },
            });
            // Only the shared-warning cell binds the Source to a second Flow
            // (Flow-owned bindings, v0048).
            if (state === "shared-warning")
              flows.set(secondFlowID, {
                ...flows.get(flowID)!,
                flow_id: secondFlowID,
                name: "Other flow",
              });
          }
          if (
            ["loading", "error", "busy", "revision-412", "model-503"].includes(
              state,
            )
          )
            await page.route(`**/ui/v1/flows/${flowID}`, async (route) => {
              const get = route.request().method() === "GET";
              if (
                (get && ["loading", "error"].includes(state)) ||
                (!get && ["busy", "revision-412", "model-503"].includes(state))
              ) {
                reached++;
                if (["loading", "busy"].includes(state)) await held;
                return route.fulfill({
                  status: state === "revision-412" ? 412 : 503,
                  json: {
                    code:
                      state === "revision-412"
                        ? "stale_revision"
                        : "model_gateway_unavailable",
                    message: "Refresh the Flow before retrying",
                  },
                });
              }
              return route.fallback();
            });
          // The approved edit cell selects every available model, so its
          // Add existing model command is disabled.
          if (state === "edit") flows.get(flowID)!.model_aliases = [...aliases];
          const create = state === "create";
          await page.goto(
            `${proxy.baseUrl}?view=flows&team=1${create ? "" : `&id=${flowID}`}`,
          );
          if (create) await createFlowEntry(page).click();
          const dialog = flowEditor(page);
          await expect(dialog).toBeVisible();
          if (["loading", "error"].includes(state)) {
            await expect.poll(() => reached).toBeGreaterThan(0);
            await expect(dialog).toContainText(
              state === "loading"
                ? /loading/i
                : /failed|unavailable|could not/i,
            );
          } else {
            if (!create)
              await expect(
                dialog.getByLabel("Name", { exact: true }),
              ).toHaveValue("Order flow");
            if (state.startsWith("source-schema")) {
              await expect(
                dialog.getByRole("checkbox", {
                  name: "Shared Source",
                  exact: true,
                }),
              ).toBeChecked();
              // Approved flow-create.html shows Source readiness as a badge.
              await expect(
                dialog.locator("[data-flow-sources] .badge"),
              ).toHaveText(
                {
                  awaiting_schema: "Awaiting schema",
                  incomplete: "Needs settings",
                  complete: "Ready",
                }[sourceStatus],
              );
            }
            if (state === "shared-warning")
              await expect(dialog.locator("[data-flow-sources]")).toContainText(
                /shared|source.*settings/i,
              );
            if (state === "validation") {
              await dialog.getByLabel("Name", { exact: true }).fill("");
              await dialog
                .getByRole("button", { name: "Save flow", exact: true })
                .click();
              expect(writes).toEqual([]);
              expect(
                await dialog
                  .getByLabel("Name", { exact: true })
                  .evaluate((e: HTMLInputElement) => e.validity.valid),
              ).toBe(false);
            }
            if (["busy", "revision-412", "model-503"].includes(state)) {
              await dialog
                .getByLabel("Name", { exact: true })
                .fill("Updated flow");
              await dialog
                .getByRole("button", { name: "Save flow", exact: true })
                .click();
              await expect.poll(() => reached).toBe(1);
              if (state === "busy")
                await expect(
                  dialog.getByRole("button", {
                    name: "Save flow",
                    exact: true,
                  }),
                ).toBeDisabled();
              else await expect(dialog.locator(".validation")).not.toBeEmpty();
            }
          }
          // Keep the pointer off the submitted command so hover styling
          // does not leak into the captured state.
          await page.mouse.move(0, 0);
          await captureDesignState(
            page,
            info,
            proxy.webUIImageID,
            `flow-create.html-${state}-${theme}-${width}`,
          );
          if (
            [
              "default",
              "edit",
              "validation",
              "busy",
              "revision-412",
              "model-503",
              "source-schema-incomplete",
              "source-schema-complete",
            ].includes(state)
          ) {
            // The approved settings-flows.html review sheet samples a Flow
            // that already uses every allowed model row, so its Add existing
            // model command is disabled.
            const add = flowEditor(page).getByRole("button", {
              name: "Add existing model",
              exact: true,
            });
            for (let i = 0; i < 5 && (await add.isEnabled()); i++)
              await add.click();
            await expect(add).toBeDisabled();
            await page.mouse.move(0, 0);
            await captureDesignState(
              page,
              info,
              proxy.webUIImageID,
              `settings-flows.html-${state}-${theme}-${width}`,
            );
          }
        } catch (error) {
          failures.push(error);
          await info.attach(`flow-editor-${state}-failure`, {
            body: String(error),
            contentType: "text/plain",
          });
        } finally {
          release();
          await context.close();
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Flow editor presentation batch");
    });
