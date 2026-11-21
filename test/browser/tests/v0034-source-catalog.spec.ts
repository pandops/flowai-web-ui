import type { Page } from "@playwright/test";
import {
  newKeyDialog,
  sourceDialog,
  sourceOutcomeDialog,
  type SourceCommand,
  type sourceOutcomeTitle,
} from "../fixtures/approved-dialogs";
import { captureDesignState, designViewport } from "../fixtures/design-capture";
import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture, flowID } from "../fixtures/v0034-flow";

// Keep missing-control failures inside the teardown deadline.
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

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.8 Source catalog retains canonical identities and eligible edge administration ${theme} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      const { writes, flows } = await flowFixture(page);
      // Flow-owned bindings (v0048): the Flow binds all three Sources.
      flows.get(flowID)!.source_ids = [8013, 8014, 8030];
      const poller = {
        source_id: 8013,
        name: "polling-pipeline",
        team_id: 1,
        revision: 3,
        mode: "poller",
        enabled: true,
        contract_version: "source.v1",
        implementation_version: "revision-3",
        description: "Long source description ".repeat(7).trim(),
        filter_summary: "Priority and component conditions ".repeat(5).trim(),
        settings_status: "complete",
        health: "stale",
        last_seen_at: "2026-10-18T00:00:00Z",
        polling: {
          polling_blocked_at: "2026-10-18T00:01:00Z",
          consecutive_failures: 5,
          next_poll_at: null,
        },
        last_poll: {
          poll_id: 7029,
          status: "failed",
          outcome: "failed",
          error_code: "callback_failed",
          started_at: "2026-10-18T00:00:00Z",
          finished_at: "2026-10-18T00:01:00Z",
          returned_tasks: 0,
        },
        intake_counts: {
          published: 49,
          rejected: 0,
          accepted: 32,
          deduplicated: 8,
          no_target: 0,
          failed: 9,
        },
      };
      const webhook = {
        ...poller,
        source_id: 8014,
        name: "webhook-pipeline",
        mode: "webhook",
        last_poll: null,
        polling: null,
        webhook_url: "https://receiver.example/webhook/1/webhook-pipeline/task",
      };
      const disabled = {
        ...webhook,
        source_id: 8030,
        name: "disabled-pipeline",
        enabled: false,
      };
      await page.route("**/ui/v1/sources?**", (route) =>
        route.fulfill({
          json: { items: [poller, webhook, disabled], next_cursor: null },
        }),
      );
      for (const source of [poller, webhook, disabled]) {
        await page.route(`**/ui/v1/sources/${source.source_id}`, (route) =>
          route.fulfill({ json: source, headers: { etag: '"rev-3"' } }),
        );
        await page.route(
          `**/ui/v1/sources/${source.source_id}/settings`,
          (route) =>
            route.fulfill({
              json: {
                source_id: source.source_id,
                mode: source.mode,
                settings_status: source.settings_status,
                fields: [],
                platform: {
                  poll_url:
                    source.mode === "poller"
                      ? "https://poller.example/tasks"
                      : null,
                  poll_interval_minutes: 7,
                  webhook_url:
                    source.mode === "webhook" ? webhook.webhook_url : null,
                },
              },
              headers: { etag: '"rev-3"' },
            }),
        );
      }
      await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
      const root = page.locator("#source-results");
      const row = (name: string) =>
        root
          .locator("tr:visible,article:visible")
          .filter({ has: page.getByRole("link", { name, exact: true }) });
      const open = async (name: string) => {
        await row(name)
          .getByRole("button", { name: `Actions for ${name}`, exact: true })
          .click();
        return page.getByRole("menu", {
          name: `Actions for ${name}`,
          exact: true,
        });
      };
      await expect(
        root.getByRole("link", { name: poller.name, exact: true }),
      ).toBeVisible();
      await expect(
        root.locator("th,dt").filter({ hasText: /^Actions$/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Manage flows", exact: true }),
      ).toHaveCount(0);
      for (const [source, tone] of [
        // Catalog tones: blocked and disabled Sources use warn, complete
        // settings success.
        [poller, "warn"],
        [webhook, "success"],
        [disabled, "warn"],
      ] as const) {
        const colors = await row(source.name)
          .locator(".badge")
          .evaluate((badge, tone) => {
            const reference = document.createElement("span");
            reference.style.cssText = `color:var(--${tone});background:var(--${tone}-bg);border:1px solid var(--${tone});`;
            reference.hidden = true;
            document.body.append(reference);
            const read = (element: Element) => {
              const style = getComputedStyle(element);
              return {
                color: style.color,
                background: style.backgroundColor,
                border: style.borderTopColor,
              };
            };
            const result = {
              actual: read(badge),
              approvedSemanticTone: read(reference),
            };
            reference.remove();
            return result;
          }, tone);
        expect(colors.actual).toEqual(colors.approvedSemanticTone);
      }
      const menu = await open(poller.name);
      // Source command order.
      await expect(menu.getByRole("menuitem")).toHaveText([
        "Edit source",
        "Unblock polling",
        "Rotate key",
        "Update version",
        "Disable source",
      ]);
      await menu
        .getByRole("menuitem", { name: "Unblock polling", exact: true })
        .click();
      const unblock = sourceDialog(
        page,
        "Unblock polling",
        poller.name,
        "poller",
      );
      await expect(unblock).toContainText(poller.name);
      await expect(unblock).toContainText("after the configured interval");
      await expect(unblock).not.toContainText("settings in its Flows");
      await unblock
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(
        row(poller.name).getByRole("button", {
          name: `Actions for ${poller.name}`,
          exact: true,
        }),
      ).toBeFocused();
      const webhookMenu = await open(webhook.name);
      await expect(
        webhookMenu.getByRole("menuitem", {
          name: "Unblock polling",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      const disabledMenu = await open(disabled.name);
      await expect(disabledMenu.getByRole("menuitem")).toHaveText([
        "Edit source",
      ]);
      await page.keyboard.press("Escape");
      const record = row(poller.name);
      await expect(
        record.getByRole("link", { name: "Order flow", exact: true }),
      ).toHaveAttribute("href", `?view=flow&team=1&id=${flowID}`);
      // Source identity fields stay concise: the record names the Source
      // only; description and filter summary belong to the detail page.
      await expect(record).not.toContainText(poller.description);
      await expect(record).not.toContainText(poller.filter_summary);
      await expect(
        record.getByText("Polling blocked", { exact: true }),
      ).toBeVisible();
      await row(poller.name)
        .getByRole("link", { name: poller.name, exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`view=source&team=1&id=${poller.source_id}`),
      );
      await expect(
        page
          .locator("#source-detail")
          .getByRole("heading", { name: "Administration", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("link", {
          name: "Open Sources administration",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        page
          .locator("#source-detail .metadata dt")
          .filter({ hasText: /^Shared configuration$/ }),
      ).toBeVisible();
      const settingsBadge = page
        .locator("#source-detail .metadata > div")
        .filter({ has: page.getByText("Settings", { exact: true }) })
        .locator("dd .badge");
      await expect(settingsBadge).toHaveText(/^complete$/i);
      await settingsBadge.scrollIntoViewIfNeeded();
      await expect(settingsBadge).toBeVisible();
      expect(
        await settingsBadge.evaluate((element) =>
          Boolean(
            element.closest(
              'button,a,input,select,textarea,[role="button"],[role="link"],[tabindex]',
            ),
          ),
        ),
      ).toBe(false);
      expect((await settingsBadge.boundingBox())!.height).toBeCloseTo(28, 0);
      await expect(
        settingsBadge.locator(
          'button,a,input,select,textarea,[role="button"],[role="link"],[tabindex]',
        ),
      ).toHaveCount(0);
      await captureDesignState(
        page,
        test.info(),
        proxy.webUIImageID,
        `source-inspection-${theme}-${width}`,
      );
      // Bound Flows come from the Flow catalog (v0048 Flow-owned
      // bindings); a failed catalog read leaves the detail usable.
      for (const status of [404, 503]) {
        let failedFlowRead = false;
        await page.route("**/ui/v1/flows?**", (route) => {
          failedFlowRead = true;
          return route.fulfill({
            status,
            json: {
              code: status === 404 ? "not_found" : "unavailable",
              name: "Unconfirmed error payload name",
            },
          });
        });
        await page.reload();
        await expect(
          page
            .locator("#source-detail .metadata dt")
            .filter({ hasText: /^Shared configuration$/ }),
        ).toBeVisible();
        expect(failedFlowRead).toBe(true);
        await expect(page.locator("#source-detail")).toContainText(
          "Flow usage unavailable",
        );
        await expect(page.locator("#source-detail .link-list")).toHaveCount(0);
        await expect(page.locator("#source-detail")).not.toContainText(
          "Unconfirmed error payload name",
        );
        await captureDesignState(
          page,
          test.info(),
          proxy.webUIImageID,
          `source-using-flow-${status}-${theme}-${width}`,
        );
      }
      expect(writes).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });

test("v0034.8 Source administration remains available during optional Flow-name network failure and held", async ({
  page,
}) => {
  const { writes } = await flowFixture(page);
  const source = {
    source_id: 8013,
    team_id: 1,
    name: "independent-source",
    mode: "poller",
    enabled: true,
    revision: 1,
    contract_version: "source.v1",
    implementation_version: "fixture",
    description: "",
    filter_summary: "",
    settings_status: "complete",
    health: "never_seen",
    activity: null,
    created_at: "2026-10-18T00:00:00Z",
    last_seen_at: null,
    last_poll: null,
    webhook_url: null,
    polling: {
      consecutive_failures: 0,
      polling_blocked_at: null,
      next_poll_at: null,
    },
    intake_counts: {
      published: 0,
      rejected: 0,
      accepted: 0,
      deduplicated: 0,
      no_target: 0,
      failed: 0,
    },
  };
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({ json: { items: [source], next_cursor: null } }),
  );
  let outcome: "held" | "network failure" = "network failure",
    release!: () => void,
    captured = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ui/v1/flows?**", async (route) => {
    captured = true;
    if (outcome === "held") {
      await held;
      return route.fallback();
    }
    await route.abort("failed");
  });
  try {
    for (const current of ["network failure", "held"] as const)
      await test.step(`v0034.8 Source administration remains available during optional Flow-name ${current}`, async () => {
        outcome = current;
        captured = false;
        await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
        await expect.poll(() => captured).toBe(true);
        await expect(
          page.getByRole("link", { name: source.name, exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", {
            name: `Actions for ${source.name}`,
            exact: true,
          })
          .click();
        await expect(
          page
            .getByRole("menu", {
              name: `Actions for ${source.name}`,
              exact: true,
            })
            .getByRole("menuitem", { name: "Edit source", exact: true }),
        ).toBeVisible();
        expect(writes).toEqual([]);
      });
  } finally {
    release();
  }
});

// These scenarios exercise public Source projections through the built UI.
// They do not qualify the backend lifecycle transactions with fixture writes.
async function sourcePresentationFixture(
  page: Page,
  options: {
    mode?: string;
    bound?: boolean;
    blocked?: boolean;
    enabled?: boolean;
  } = {},
) {
  const { writes, flows } = await flowFixture(page);
  flows.get(flowID)!.source_ids = options.bound ? [8013] : [];
  const source = {
    source_id: 8013,
    team_id: 1,
    name: "presentation-source",
    revision: 3,
    mode: options.mode || "poller",
    enabled: options.enabled !== false,
    implementation_version: "release-3",
    contract_version: "source.v1",
    description: "Readable Source configuration",
    filter_summary: "Ready items",
    settings_status: "complete",
    health: "healthy",
    activity: "Ready",
    last_seen_at: "2026-10-18T00:00:00Z",
    polling:
      options.mode === "webhook"
        ? null
        : {
            polling_blocked_at: options.blocked ? "2026-10-18T00:01:00Z" : null,
            consecutive_failures: options.blocked ? 5 : 0,
            next_poll_at:
              options.blocked || options.enabled === false
                ? null
                : "2026-10-20T12:00:00Z",
          },
    last_poll: null,
    webhook_url:
      options.mode === "webhook"
        ? "https://receiver.example/webhook/1/presentation-source/task"
        : null,
    intake_counts: {
      published: 26,
      rejected: 0,
      accepted: 24,
      deduplicated: 2,
      no_target: 0,
      failed: 0,
    },
  };
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({ json: { items: [source], next_cursor: null } }),
  );
  await page.route(`**/ui/v1/sources/${source.source_id}`, (route) =>
    route.fulfill({ json: source, headers: { etag: '"rev-3"' } }),
  );
  await page.route(`**/ui/v1/sources/${source.source_id}/settings`, (route) =>
    route.fulfill({
      json: {
        source_id: source.source_id,
        mode: source.mode,
        settings_status: source.settings_status,
        fields: [],
        platform: {
          poll_url:
            source.mode === "poller" ? "https://poller.example/tasks" : null,
          poll_interval_minutes: source.mode === "poller" ? 5 : null,
          webhook_url: source.webhook_url,
        },
      },
      headers: { etag: '"rev-3"' },
    }),
  );
  let modelReads = 0;
  await page.route("**/ui/v1/models**", (route) => {
    modelReads++;
    return route.fulfill({ status: 503, json: {} });
  });
  return { source, writes, modelReads: () => modelReads };
}

for (const theme of ["dark", "light"] as const)
  for (const width of [390, 820, 1440]) {
    test(`v0034.8 approved Source catalog states ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout(240_000);
      for (const state of [
        "default",
        "poller",
        "webhook",
        "disabled",
        "blocked-poller",
        "loading",
        "empty",
        "error",
        "rotate-source",
        "disable-source",
        "poller-unblock",
        "source-version",
        "source-edit-none",
        "source-edit-single",
      ]) {
        const page = await context.newPage(),
          failures: unknown[] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          await page.setViewportSize(designViewport(width));
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          const { source, writes, modelReads } =
            await sourcePresentationFixture(page, {
              mode: state === "webhook" ? "webhook" : "poller",
              enabled: state !== "disabled",
              blocked: ["blocked-poller", "poller-unblock"].includes(state),
              bound: state === "source-edit-single",
            });
          let recovered = false;
          await page.route("**/ui/v1/sources?**", async (route) => {
            if (state === "loading") await held;
            if (state === "error" && !recovered)
              return route.fulfill({ status: 503, json: {} });
            return route.fulfill({
              json: {
                items: state === "empty" ? [] : [source],
                next_cursor: null,
              },
            });
          });
          await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
          const root = page.locator("#source-results");
          if (state === "loading")
            await expect(root.getByRole("status")).toContainText("Loading…");
          else if (state === "empty")
            await expect(root).toContainText("No records available.");
          else if (state === "error")
            await expect(root.getByRole("alert")).toBeVisible();
          else {
            await expect(
              root.getByRole("link", { name: source.name, exact: true }),
            ).toBeVisible();
            if (state === "disabled")
              await expect(root.locator(".badge:visible")).toHaveText([
                "Disabled",
              ]);
            if (state === "blocked-poller")
              await expect(root.locator(".badge:visible")).toHaveText([
                "Polling blocked",
              ]);
            if (state === "source-edit-single")
              await expect(
                root.getByRole("link", { name: "Order flow", exact: true }),
              ).toBeVisible();
            const commands: Record<string, string> = {
              "rotate-source": "Rotate key",
              "disable-source": "Disable source",
              "poller-unblock": "Unblock polling",
              "source-version": "Update version",
              "source-edit-none": "Edit source",
              "source-edit-single": "Edit source",
            };
            if (commands[state]) {
              await root
                .getByRole("button", {
                  name: `Actions for ${source.name}`,
                  exact: true,
                })
                .click();
              const menu = page.getByRole("menu", {
                name: `Actions for ${source.name}`,
                exact: true,
              });
              await expect(
                menu.getByRole("menuitem", {
                  name: commands[state],
                  exact: true,
                }),
              ).toBeEnabled();
              if (!state.startsWith("source-edit")) {
                await menu
                  .getByRole("menuitem", { name: commands[state], exact: true })
                  .click();
                await expect(
                  sourceDialog(
                    page,
                    commands[state] as SourceCommand,
                    source.name,
                    state === "webhook" ? "webhook" : "poller",
                  ),
                ).toBeVisible();
              }
            }
          }
          expect(writes).toEqual([]);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          // The approved state has no pointer hover on a clicked command.
          await page.mouse.move(0, 0);
          await captureDesignState(
            page,
            test.info(),
            proxy.webUIImageID,
            `sources.html-${state}-${theme}-${width}`,
          );
          if (["poller-unblock", "source-version"].includes(state))
            await captureDesignState(
              page,
              test.info(),
              proxy.webUIImageID,
              `operation-states.html-${state}-${theme}-${width}`,
            );
          // Asynchronous outcomes of the same confirmed operations: a held
          // request, a temporary failure, a stale revision and an unfinished
          // poll conflict. No outcome may fabricate success.
          const outcomes: Record<string, [string, number | "held"][]> = {
            "poller-unblock": [
              ["poller-unblock-pending", "held"],
              ["poller-unblock-failure", 503],
            ],
            "source-version": [
              ["source-version-412", 412],
              ["source-version-conflict", 409],
            ],
          };
          // The menu item opens the dialog; its submit keeps the full
          // command (approved modal-specs source-version action).
          const outcomeCommand =
            state === "poller-unblock" ? "Unblock polling" : "Update version";
          const outcomeAction =
            state === "poller-unblock"
              ? "Unblock polling"
              : "Update implementation version";
          for (const [outcome, status] of outcomes[state] ?? []) {
            const action =
              state === "poller-unblock" ? "unblock-polling" : "implementation";
            let releaseWrite!: () => void;
            const writeHeld = new Promise<void>((resolve) => {
              releaseWrite = resolve;
            });
            const endpoint = `**/ui/v1/sources/${source.source_id}/${action}`;
            let attempts = 0;
            await page.route(endpoint, async (route) => {
              attempts++;
              if (status === "held") await writeHeld;
              const code =
                status === 409
                  ? "poll_in_progress"
                  : status === 412
                    ? "precondition_failed"
                    : "unavailable";
              return route.fulfill({
                status: status === "held" ? 503 : status,
                json: { code },
              });
            });
            const dialog = sourceDialog(
              page,
              outcomeCommand as SourceCommand,
              source.name,
              "poller",
            );
            // After submission the dialog title names the outcome.
            const outcomeDialog = sourceOutcomeDialog(
              page,
              outcome as keyof typeof sourceOutcomeTitle,
              source.name,
            );
            if (!(await dialog.isVisible())) {
              await root
                .getByRole("button", {
                  name: `Actions for ${source.name}`,
                  exact: true,
                })
                .click();
              await page
                .getByRole("menu", {
                  name: `Actions for ${source.name}`,
                  exact: true,
                })
                .getByRole("menuitem", { name: outcomeCommand, exact: true })
                .click();
              await expect(dialog).toBeVisible();
            }
            if (action === "implementation")
              await dialog
                .getByLabel("Implementation version", { exact: true })
                .fill("2");
            await dialog
              .getByRole("button", { name: outcomeAction, exact: true })
              .click();
            await expect.poll(() => attempts).toBe(1);
            await expect(outcomeDialog).toBeVisible();
            if (status === "held")
              await expect(
                outcomeDialog.getByRole("button", {
                  name: outcomeAction,
                  exact: true,
                }),
              ).toBeDisabled();
            else await expect(outcomeDialog.getByRole("alert")).toBeVisible();
            await captureDesignState(
              page,
              test.info(),
              proxy.webUIImageID,
              `operation-states.html-${outcome}-${theme}-${width}`,
            );
            releaseWrite();
            // A held request that then fails ends in the failure outcome.
            const settled =
              status === "held"
                ? sourceOutcomeDialog(
                    page,
                    "poller-unblock-failure",
                    source.name,
                  )
                : outcomeDialog;
            await expect(settled.getByRole("alert")).toBeVisible();
            await expect(settled).not.toContainText(/saved|unblocked|updated/i);
            await page.unroute(endpoint);
            await settled
              .getByRole("button", { name: "Close", exact: true })
              .click();
            await expect(settled).toBeHidden();
          }
          if (state.startsWith("source-edit")) {
            await page
              .getByRole("menu", {
                name: `Actions for ${source.name}`,
                exact: true,
              })
              .getByRole("menuitem", { name: "Edit source", exact: true })
              .click();
            await expect(page.locator("#source-settings-form")).toBeVisible();
            await expect(page).toHaveURL(
              new RegExp(`view=source-edit.*id=${source.source_id}`),
            );
            expect(modelReads()).toBe(0);
          }
          if (state === "error") {
            // Owner review 2026-10-25: no in-place Retry command; recovery
            // reloads the catalog.
            await expect(
              root.getByRole("button", { name: "Retry", exact: true }),
            ).toHaveCount(0);
            recovered = true;
            await page.reload();
            await expect(
              root.getByRole("link", { name: source.name, exact: true }),
            ).toBeVisible();
          }
          // Only the outcome submissions driven above may write; every
          // request is page-recorded, including route-fulfilled ones.
          expect(writes).toEqual(
            (outcomes[state] ?? []).map(() => ({
              path: `/ui/v1/sources/${source.source_id}/${
                state === "poller-unblock"
                  ? "unblock-polling"
                  : "implementation"
              }`,
              body:
                state === "poller-unblock"
                  ? null
                  : { implementation_version: "2" },
              etag: '"rev-3"',
            })),
          );
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
        if (failures.length === 1) throw failures[0];
        if (failures.length)
          throw new AggregateError(
            failures,
            "Source catalog state and teardown failures",
          );
      }
    });

    test(`v0034.8 approved Source confirmation states ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout(240_000);
      for (const operation of ["disable", "rotate-key"] as const)
        for (const state of operation === "disable"
          ? ["default", "confirm", "invalid-name", "busy", "error"]
          : ["default", "confirm", "busy", "error", "key-result"]) {
          const page = await context.newPage(),
            failures: unknown[] = [];
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          try {
            await page.setViewportSize(designViewport(width));
            await page.addInitScript(
              (value) => localStorage.setItem("flowai.theme", value),
              theme,
            );
            const { source, writes } = await sourcePresentationFixture(page, {
              mode: operation === "disable" ? "poller" : "webhook",
            });
            let dispatched = 0;
            await page.route(
              `**/ui/v1/sources/${source.source_id}/${operation}`,
              async (route) => {
                expect(route.request().method()).toBe("POST");
                expect(route.request().postData()).toBeNull();
                dispatched++;
                if (state === "busy") await held;
                await route.fulfill(
                  state === "key-result"
                    ? {
                        json: {
                          source,
                          api_key: "synthetic-ui-only-source-key",
                        },
                      }
                    : { status: 503, json: {} },
                );
              },
            );
            await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
            const trigger = page.getByRole("button", {
              name: `Actions for ${source.name}`,
              exact: true,
            });
            await trigger.click();
            const label =
              operation === "disable" ? "Disable source" : "Rotate key";
            await page
              .getByRole("menu", {
                name: `Actions for ${source.name}`,
                exact: true,
              })
              .getByRole("menuitem", { name: label, exact: true })
              .click();
            const dialog = sourceDialog(
                page,
                label as SourceCommand,
                source.name,
                source.mode,
              ),
              submit = dialog.getByRole("button", { name: label, exact: true });
            await expect(dialog).toBeVisible();
            await expect(
              dialog.getByRole("button", { name: "Cancel", exact: true }),
            ).toBeFocused();
            if (operation === "disable") {
              await expect(submit).toBeDisabled();
              if (state !== "default")
                await dialog
                  .getByLabel("Type exact source name", { exact: true })
                  .fill(state === "invalid-name" ? "wrong-name" : source.name);
              if (state === "invalid-name") {
                await expect(
                  dialog.getByRole("alert").filter({
                    hasText: `Enter ${source.name} exactly. The display title does not authorize Disable source.`,
                  }),
                ).toBeVisible();
                await expect(
                  dialog.getByLabel("Type exact source name", { exact: true }),
                ).toHaveAttribute("aria-invalid", "true");
              }
              if (["default", "invalid-name"].includes(state)) {
                await expect(submit).toBeDisabled();
                await dialog
                  .locator("form")
                  .evaluate((form) =>
                    form.dispatchEvent(
                      new Event("submit", { bubbles: true, cancelable: true }),
                    ),
                  );
                expect(dispatched).toBe(0);
              } else await expect(submit).toBeEnabled();
            }
            if (["busy", "error", "key-result"].includes(state)) {
              await submit.click();
              await expect.poll(() => dispatched).toBe(1);
              if (state === "busy") {
                await expect(submit).toBeDisabled();
                await expect(
                  dialog.getByRole("button", { name: "Cancel", exact: true }),
                ).toBeDisabled();
                await page.keyboard.press("Escape");
                await expect(dialog).toBeVisible();
              } else if (state === "error")
                await expect(dialog.locator(".validation")).toHaveText(
                  "Request failed Check the connection and retry. Credentials and prior-team data are not shown.",
                );
              else {
                await expect(newKeyDialog(page, source.name)).toBeVisible();
                await expect(page.locator("[data-source-key]")).toHaveText(
                  "synthetic-ui-only-source-key",
                );
              }
            }
            const screen =
              operation === "disable"
                ? "source-disable-confirm.html"
                : "source-rotate-confirm.html";
            // The approved state has no pointer hover on the clicked command.
            await page.mouse.move(0, 0);
            await captureDesignState(
              page,
              test.info(),
              proxy.webUIImageID,
              `${screen}-${state}-${theme}-${width}`,
            );
            expect(writes).toHaveLength(
              ["busy", "error", "key-result"].includes(state) ? 1 : 0,
            );
            if (state === "busy") {
              release();
              await expect(dialog.locator(".validation")).toContainText(
                "Request failed",
              );
              await expect(
                dialog.getByRole("button", { name: "Cancel", exact: true }),
              ).toBeEnabled();
            }
            if (state === "invalid-name") {
              await dialog
                .getByLabel("Type exact source name", { exact: true })
                .fill(source.name);
              await expect(
                dialog.getByRole("alert").filter({
                  hasText: `Enter ${source.name} exactly. The display title does not authorize Disable source.`,
                }),
              ).toHaveCount(0);
              await expect(
                dialog.getByLabel("Type exact source name", { exact: true }),
              ).toHaveAttribute("aria-invalid", "false");
              await expect(submit).toBeEnabled();
              expect(dispatched).toBe(0);
            }
            if (state === "key-result") {
              await page
                .getByRole("button", { name: "Close and clear", exact: true })
                .click();
              await expect(page.locator("[data-source-key]")).toHaveCount(0);
              await expect(page.locator("body")).not.toContainText(
                "synthetic-ui-only-source-key",
              );
            } else {
              await dialog
                .getByRole("button", { name: "Cancel", exact: true })
                .click();
              await expect(dialog).toHaveCount(0);
              await expect(trigger).toBeFocused();
            }
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
          if (failures.length === 1) throw failures[0];
          if (failures.length)
            throw new AggregateError(
              failures,
              "Source confirmation state and teardown failures",
            );
        }
    });
  }

// Retained screenshots complement behavior assertions; they are not a full visual verdict.
test.afterEach(async ({ page }, info) => {
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    `final-${info.title}`,
  );
});
