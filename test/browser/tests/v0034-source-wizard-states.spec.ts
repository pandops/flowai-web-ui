import path from "node:path";
import {
  cancelSourceWizard,
  createSourceEntry,
  sourceKeyPage,
  sourceWizard,
} from "../fixtures/source-wizard";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture } from "../fixtures/v0034-flow";
import { captureDesignState } from "../fixtures/design-capture";

const viewports = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 },
] as const;

let proxy: MockedProxy;
test.use({ actionTimeout: 10_000 });
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

for (const theme of ["dark", "light"] as const)
  for (const { width, height } of viewports)
    test(`v0034.8 Source presentation states wizard validation and key copying ${theme} ${width}`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"]);
      const { writes } = await flowFixture(page);
      const source = {
        source_id: 8013,
        team_id: 1,
        name: "wizard-source",
        mode: "webhook",
        enabled: true,
        revision: 1,
        contract_version: "source.v1",
        implementation_version: "release-1",
        description: "Retained wizard draft",
        filter_summary: "",
        settings_status: "awaiting_schema",
        health: "never_seen",
        intake_counts: {
          published: 0,
          rejected: 0,
          accepted: 0,
          deduplicated: 0,
          no_target: 0,
          failed: 0,
        },
      };
      // A synthetic one-time UI premise, never a provider credential.
      const key = "source-wizard-synthetic-one-time-value";
      let response: "conflict" | "error" | "held" = "conflict";
      let created = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const captures: string[] = [];
      const capture = async (screen: string, state: string) => {
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (state !== "cleared") {
          const steps = page
            .locator("main")
            .getByRole("list", { name: "Source creation steps", exact: true });
          await expect(steps).toBeVisible();
          await expect(steps.getByRole("listitem")).toHaveText([
            "1 · Name",
            "2 · Details",
            "3 · Key",
          ]);
          const active =
            screen === "source-key.html" || state === "key-ready"
              ? "3 · Key"
              : ["default", "invalid-name", "conflict-name"].includes(state)
                ? "1 · Name"
                : "2 · Details";
          await expect(steps.locator('[aria-current="step"]')).toHaveText(
            active,
          );
        }
        const label = `${screen}-${state}-${theme}-${width}`;
        // The approved state has no pointer hover; park the pointer off the
        // command that was just clicked.
        await page.mouse.move(0, 0);
        await captureDesignState(page, test.info(), proxy.webUIImageID, label);
        captures.push(`${screen}?state=${state}`);
      };
      await page.route("**/ui/v1/sources?**", (route) =>
        route.fulfill({
          json: { items: created ? [source] : [], next_cursor: null },
        }),
      );
      await page.route("**/ui/v1/sources", async (route) => {
        expect(route.request().method()).toBe("POST");
        expect(route.request().postDataJSON()).toEqual({
          name: source.name,
          mode: source.mode,
          implementation_version: source.implementation_version,
          contract_version: "source.v1",
          description: source.description,
          filter_summary: "",
        });
        if (response === "conflict")
          return route.fulfill({
            status: 409,
            json: { code: "source_name_conflict" },
          });
        if (response === "error")
          return route.fulfill({ status: 503, json: { code: "unavailable" } });
        await held;
        created = true;
        await route.fulfill({ status: 201, json: { source, api_key: key } });
      });

      try {
        await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
        const create = createSourceEntry(page);
        await expect(create).toBeVisible();
        await create.click();
        // v0034: registration is the standalone "Register source" page.
        const dialog = sourceWizard(page);
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole("heading", {
            name: "Add Source · Name",
            exact: true,
          }),
        ).toBeVisible();
        expect(
          await dialog.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        ).toBe(true);
        await capture("source-create.html", "default");

        await dialog.getByLabel("Name", { exact: true }).fill("/invalid");
        await dialog.getByRole("button", { name: "Next", exact: true }).click();
        await expect(dialog.getByRole("alert")).toHaveText(
          "Use 1–63 URL-safe characters; “.” and “..” are not valid names.",
        );
        await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
        expect(writes).toEqual([]);
        await capture("source-create.html", "invalid-name");

        await dialog.getByLabel("Name", { exact: true }).fill(source.name);
        await dialog.getByRole("button", { name: "Next", exact: true }).click();
        await expect(
          dialog.getByRole("heading", {
            name: "Add Source · Details",
            exact: true,
          }),
        ).toBeVisible();
        await dialog
          .getByLabel("Description (optional)", { exact: true })
          .fill(source.description);
        await capture("source-create.html", "details");
        await dialog
          .getByRole("button", { name: "Create source", exact: true })
          .click();
        await expect(dialog.getByLabel("Mode", { exact: true })).toBeFocused();
        expect(
          await dialog
            .getByLabel("Mode", { exact: true })
            .evaluate(
              (element: HTMLSelectElement) => element.validity.valueMissing,
            ),
        ).toBe(true);
        expect(writes).toEqual([]);
        await capture("source-create.html", "invalid-details");

        await dialog
          .getByLabel("Mode", { exact: true })
          .selectOption("webhook");
        await dialog
          .getByLabel("Implementation version", { exact: true })
          .fill(source.implementation_version);
        await dialog
          .getByRole("button", { name: "Create source", exact: true })
          .click();
        await expect(dialog.getByRole("alert")).toHaveText(
          "This name is already registered in the selected team. Enter a different name.",
        );
        await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
          source.name,
        );
        await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
        expect(writes).toHaveLength(1);
        await capture("source-create.html", "conflict-name");

        await dialog.getByRole("button", { name: "Next", exact: true }).click();
        await expect(
          dialog.getByLabel("Description (optional)", { exact: true }),
        ).toHaveValue(source.description);
        await expect(dialog.getByLabel("Mode", { exact: true })).toHaveValue(
          "webhook",
        );
        await expect(
          dialog.getByLabel("Implementation version", { exact: true }),
        ).toHaveValue(source.implementation_version);
        response = "error";
        await dialog
          .getByRole("button", { name: "Create source", exact: true })
          .click();
        await expect(dialog.getByRole("alert")).toContainText(
          "No key was received",
        );
        await expect(
          dialog.getByLabel("Description (optional)", { exact: true }),
        ).toHaveValue(source.description);
        expect(writes).toHaveLength(2);
        await capture("source-create.html", "error");

        response = "held";
        await dialog
          .getByRole("button", { name: "Create source", exact: true })
          .click();
        await expect.poll(() => writes.length).toBe(3);
        // Approved busy state: one disabled "Creating…" submit, Back disabled;
        // leaving through Cancel never repeats the request.
        await expect(
          dialog.getByRole("button", { name: "Creating…", exact: true }),
        ).toBeDisabled();
        await expect(
          dialog.getByRole("button", { name: "Back", exact: true }),
        ).toBeDisabled();
        await expect(cancelSourceWizard(dialog)).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
            exact: true,
          }),
        ).toBeEnabled();
        await capture("source-create.html", "busy");
        release();
        const keyDialog = sourceKeyPage(
          page,
          `One-time key for ${source.name}`,
        );
        await expect(keyDialog).toBeVisible();
        await expect(
          keyDialog.getByLabel("Source key", { exact: true }),
        ).toHaveText(key);
        await expect(keyDialog).toContainText("shown once");
        await capture("source-create.html", "key-ready");
        await capture("source-key.html", "default");
        await capture("source-key.html", "revealed");

        const deniedCopy = async () => {
          await page.evaluate(() => {
            Object.defineProperty(navigator.clipboard, "writeText", {
              configurable: true,
              value: () =>
                Promise.reject(new Error("fixture clipboard denied")),
            });
          });
          try {
            await keyDialog
              .getByRole("button", { name: "Copy key", exact: true })
              .click();
            await expect(keyDialog.getByRole("alert")).toHaveText(
              "Select and copy the key from the field.",
            );
            await expect(
              keyDialog.getByText("Key copied.", { exact: true }),
            ).toHaveCount(0);
          } finally {
            await page.evaluate(() =>
              Reflect.deleteProperty(navigator.clipboard, "writeText"),
            );
          }
        };
        await deniedCopy();
        await keyDialog
          .getByRole("button", { name: "Copy key", exact: true })
          .click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          key,
        );
        await expect(keyDialog.getByRole("alert")).toBeEmpty();
        await expect(keyDialog.getByRole("status")).toHaveText("Key copied.");
        await capture("source-key.html", "copied");
        // A later denial must clear the earlier successful acknowledgement.
        await deniedCopy();
        await keyDialog
          .getByRole("button", { name: "Close and clear", exact: true })
          .click();
        await expect(page.locator("[data-source-key]")).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText(key);
        await expect(
          page.getByRole("link", { name: source.name, exact: true }),
        ).toBeVisible();
        expect(writes).toHaveLength(3);
        await capture("source-key.html", "cleared");
        await test.info().attach("approved-source-wizard-states", {
          body: JSON.stringify({
            theme,
            width,
            height,
            captures,
            mutation_count: writes.length,
            default_and_revealed_are_visible_one_time_result: true,
          }),
          contentType: "application/json",
        });
      } finally {
        release();
      }
    });

for (const theme of ["dark", "light"] as const)
  for (const { width, height } of viewports)
    for (const mode of ["poller", "webhook"] as const)
      test(`v0034.12 Source presentation states readonly inspection ${mode} ${theme} ${width}`, async ({
        context,
      }) => {
        test.setTimeout(180_000);
        const states = [
          "default",
          "loading",
          "unavailable",
          "error",
          "disabled",
          ...(mode === "poller" ? ["blocked"] : []),
        ];
        const captures: { state: string; aliases: string[] }[] = [];
        const censusFailures: string[] = [];
        for (const state of states) {
          const page = await context.newPage();
          let release!: () => void;
          const held = new Promise<void>((resolve) => (release = resolve));
          try {
            await page.setViewportSize({ width, height });
            await page.addInitScript(
              (theme) => localStorage.setItem("flowai.theme", theme),
              theme,
            );
            const { writes } = await flowFixture(page);
            const source = {
              source_id: 8013,
              team_id: 1,
              name: `inspection-${mode}`,
              mode,
              enabled: state !== "disabled",
              revision: 3,
              contract_version: "source.v1",
              implementation_version: "release-1",
              description:
                "Source inspection preserves complete readable configuration.",
              filter_summary: "Priority and component conditions",
              settings_status: "complete",
              health: "healthy",
              last_seen_at: new Date().toISOString(),
              polling:
                mode === "poller"
                  ? {
                      next_poll_at: ["blocked", "disabled"].includes(state)
                        ? null
                        : "2026-10-20T12:00:00Z",
                      polling_blocked_at:
                        state === "blocked" ? "2026-10-18T00:01:00Z" : null,
                      consecutive_failures: state === "blocked" ? 5 : 0,
                    }
                  : null,
              last_poll:
                state === "blocked"
                  ? {
                      poll_id: 8014,
                      status: "failed",
                      outcome: "failed",
                      error_code: "callback_failed",
                      started_at: "2026-10-18T00:00:00Z",
                      finished_at: "2026-10-18T00:01:00Z",
                      returned_tasks: 0,
                    }
                  : null,
              intake_counts: {
                published: 24,
                rejected: 0,
                accepted: 20,
                deduplicated: 4,
                no_target: 0,
                failed: 0,
              },
            };
            await page.route(
              `**/ui/v1/sources/${source.source_id}`,
              async (route) => {
                expect(route.request().method()).toBe("GET");
                if (state === "loading") await held;
                const status =
                  state === "unavailable" ? 404 : state === "error" ? 503 : 200;
                await route.fulfill({
                  status,
                  json:
                    status === 200
                      ? source
                      : { code: status === 404 ? "not_found" : "unavailable" },
                });
              },
            );
            await page.route(
              `**/ui/v1/sources/${source.source_id}/settings`,
              (route) =>
                route.fulfill({
                  headers: { etag: '"rev-3"' },
                  json: {
                    source_id: source.source_id,
                    mode,
                    settings_status: "complete",
                    fields: [
                      {
                        name: "project",
                        label: "Project",
                        type: "string",
                        value: "Readable project",
                        required: false,
                        description: "Configured project selector",
                      },
                      {
                        name: "batch",
                        label: "Batch size",
                        type: "integer",
                        value: 0,
                        required: true,
                        default: 10,
                      },
                      {
                        name: "labels",
                        label: "Include labels",
                        type: "boolean",
                        value: false,
                        required: false,
                        default: true,
                      },
                    ],
                    platform: {
                      poll_url:
                        mode === "poller"
                          ? "https://poller.example/tasks"
                          : null,
                      poll_interval_minutes: mode === "poller" ? 5 : null,
                      webhook_url:
                        mode === "webhook"
                          ? "https://receiver.example/webhook/1/inspection-webhook/task"
                          : null,
                    },
                  },
                }),
            );
            await page.goto(
              `${proxy.baseUrl}?view=source&team=1&id=${source.source_id}`,
            );
            const root = page.locator("#source-detail");
            if (state === "loading") {
              await expect(root).toContainText(
                "Current team data is withheld until Gateway confirms the selected team.",
              );
              await expect(
                root.getByRole("link", { name: "Edit source", exact: true }),
              ).toHaveCount(0);
            } else if (["unavailable", "error"].includes(state)) {
              await expect(
                root.getByRole(state === "unavailable" ? "status" : "alert"),
              ).toContainText(
                state === "unavailable"
                  ? "unavailable to the selected team"
                  : "Check the connection and retry",
              );
              await expect(root.getByRole("heading")).toHaveText([
                state === "unavailable"
                  ? "Source unavailable"
                  : "Request failed",
              ]);
              await expect(root).not.toContainText(source.name);
              for (const text of [
                source.description,
                "Readable project",
                "Configured project selector",
                "https://poller.example/tasks",
                "https://receiver.example/webhook/1/inspection-webhook/task",
              ])
                await expect(root).not.toContainText(text);
            } else {
              await expect(
                page.getByRole("heading", {
                  level: 1,
                  name: source.name,
                  exact: true,
                }),
              ).toBeVisible();
              for (const heading of [
                "Source identity and effective settings",
                "Linked Flows",
                mode === "poller" ? "Polling" : "Webhook ingestion",
                "Source params",
                "Ingestion",
              ]) {
                await expect(
                  root.getByRole("heading", { name: heading, exact: true }),
                ).toBeVisible();
              }
              const identity = root
                .locator(".metadata > div")
                .filter({ has: page.getByText("Source ID", { exact: true }) });
              await expect(identity.locator("dd")).toHaveText(
                String(source.source_id),
              );
              // Approved Source params rows: the value, then its type,
              // requirement and schema default (ui-mockups/source-detail-*).
              await expect(root).toContainText(
                "string · optional · no default · Configured project selector",
              );
              for (const [label, value, description] of [
                ["Batch size", "0", "integer · required · default 10"],
                [
                  "Include labels",
                  "false",
                  "boolean · optional · default true",
                ],
              ]) {
                const field = root
                  .locator(".metadata > div")
                  .filter({ has: page.getByText(label, { exact: true }) })
                  .locator("dd");
                expect(
                  await field.evaluate(
                    (element) => element.firstChild?.textContent,
                  ),
                ).toBe(value);
                await expect(field).toContainText(description);
              }
              await expect(
                root
                  .locator(".metadata > div")
                  .filter({
                    has: page.getByText("Shared configuration", {
                      exact: true,
                    }),
                  })
                  .locator("dd"),
              ).toHaveText("Read-only here. Edit on the Source page.");
              await expect(
                root.getByRole("link", { name: "Edit source", exact: true }),
              ).toHaveAttribute(
                "href",
                `?view=source-edit&team=1&id=${source.source_id}`,
              );
              await expect(root).toContainText("Readable project");
              await expect(root).toContainText(source.description);
              await expect(root).toContainText("Not used by a flow");
              await expect(
                root
                  .locator(".metadata > div")
                  .filter({ has: page.getByText("Mode", { exact: true }) })
                  .locator("dd"),
              ).toHaveText(mode === "poller" ? "Poller" : "Webhook");
              await expect(
                root
                  .locator(".metadata > div")
                  .filter({ has: page.getByText("Health", { exact: true }) })
                  .locator("dd"),
              ).toHaveText(
                state === "disabled"
                  ? "Disabled"
                  : state === "blocked"
                    ? "Polling blocked"
                    : "Healthy",
              );
              if (state === "blocked") {
                // Approved read-only notice: recovery stays in Sources
                // administration, so the detail page offers no command.
                await expect(root.getByRole("status")).toContainText(
                  "Five consecutive failures stopped polling.",
                );
                await expect(
                  root.getByRole("button", {
                    name: "Unblock polling",
                    exact: true,
                  }),
                ).toHaveCount(0);
              }
              if (state === "disabled") {
                for (const name of [
                  "Rotate key",
                  "Disable source",
                  "Update implementation version",
                ])
                  await expect(
                    root.getByRole("button", { name, exact: true }),
                  ).toHaveCount(0);
              }
              await expect(root.locator("input,select,textarea")).toHaveCount(
                0,
              );
            }
            expect(writes).toEqual([]);
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const aliases = [
              `source-detail-${mode}.html`,
              `settings-sources-${mode}.html`,
            ];
            // Every state is census-checked before the test reports; a
            // census difference never hides the later states' results.
            for (const screen of aliases)
              await captureDesignState(
                page,
                test.info(),
                proxy.webUIImageID,
                `${screen}-${state}-${theme}-${width}`,
              ).catch((error) => censusFailures.push(String(error)));
            captures.push({ state, aliases });
            if (
              mode === "webhook" &&
              !["loading", "unavailable", "error"].includes(state)
            ) {
              const copied: string[] = [];
              await page.exposeFunction(
                "recordCopiedSourceURL",
                (value: string) => copied.push(value),
              );
              await page.evaluate(() =>
                Object.defineProperty(navigator, "clipboard", {
                  configurable: true,
                  value: {
                    writeText: (value: string) =>
                      (window as any).recordCopiedSourceURL(value),
                  },
                }),
              );
              await root
                .getByRole("button", { name: "Copy URL", exact: true })
                .click();
              await expect(
                root.locator("[data-source-url-copy-status]"),
              ).toHaveText("URL copied.");
              expect(copied).toEqual([
                "https://receiver.example/webhook/1/inspection-webhook/task",
              ]);
              await page.evaluate(() =>
                Object.defineProperty(navigator, "clipboard", {
                  configurable: true,
                  value: {
                    writeText: async () => {
                      throw new Error("Permission denied");
                    },
                  },
                }),
              );
              await root
                .getByRole("button", { name: "Copy URL", exact: true })
                .click();
              await expect(
                root.locator("[data-source-url-copy-status]"),
              ).toHaveText(
                "Copy was not permitted. Select and copy the URL above.",
              );
              if (state === "default") {
                await page.evaluate(() => {
                  (window as any).oldSourceCopyStatus = document.querySelector(
                    "[data-source-url-copy-status]",
                  );
                  Object.defineProperty(navigator, "clipboard", {
                    configurable: true,
                    value: {
                      writeText: () =>
                        new Promise<void>((resolve) => {
                          (window as any).releaseSourceCopy = resolve;
                        }),
                    },
                  });
                });
                await root
                  .getByRole("button", { name: "Copy URL", exact: true })
                  .click();
                await page
                  .locator('nav a[data-view="sources"]')
                  .first()
                  .evaluate((link: HTMLAnchorElement) => link.click());
                await expect(
                  page.getByRole("heading", {
                    level: 1,
                    name: "Sources",
                    exact: true,
                  }),
                ).toBeVisible();
                await page.evaluate(async () => {
                  (window as any).releaseSourceCopy();
                  await new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => resolve()),
                    ),
                  );
                });
                expect(
                  await page.evaluate(
                    () => (window as any).oldSourceCopyStatus.textContent,
                  ),
                ).toBe(
                  "Copy was not permitted. Select and copy the URL above.",
                );
              }
            }

            if (state === "loading") {
              release();
              await expect(
                root.getByRole("heading", {
                  name: "Source identity and effective settings",
                  exact: true,
                }),
              ).toBeVisible();
            }
          } finally {
            release();
            await page.unrouteAll({ behavior: "wait" });
            await page.close();
          }
        }
        await test.info().attach("approved-source-inspection-states", {
          body: JSON.stringify({
            theme,
            width,
            height,
            mode,
            captures,
            alias_contract:
              "Both approved inspection aliases use the same canonical readonly Source route.",
          }),
          contentType: "application/json",
        });
        expect(censusFailures).toEqual([]);
      });

for (const theme of ["dark", "light"] as const)
  for (const { width, height } of viewports)
    test(`v0034.12 Source presentation states independent editor save guards ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout(240_000);
      const states = [
        "blocked",
        "incomplete",
        "default",
        "poller",
        "webhook",
        "unbound",
        "disabled",
        "awaiting-schema",
        "loading",
        "unavailable",
        "error",
        "invalid",
        "busy",
        "stale-revision",
        "success",
        "unset-values",
        "schema-defaults",
      ];
      const captures: string[] = [];
      const censusFailures: string[] = [];
      for (const state of states) {
        const page = await context.newPage();
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        try {
          await page.setViewportSize({ width, height });
          await page.addInitScript(
            (theme) => localStorage.setItem("flowai.theme", theme),
            theme,
          );
          const { writes, flows } = await flowFixture(page);
          // Flow-owned bindings (v0048): Flow 44 binds the Source unless unbound.
          flows.get(44)!.source_ids = state === "unbound" ? [] : [8013];
          const mode = state === "webhook" ? "webhook" : "poller";
          const fields =
            state === "awaiting-schema"
              ? []
              : [
                  {
                    name: "project",
                    label: "Project",
                    type: "string",
                    value: state === "incomplete" ? null : "Explicit project",
                    default: state === "incomplete" ? null : "Schema project",
                    required: true,
                    description: "Project selected by this Source",
                  },
                  {
                    name: "enabled",
                    label: "Enabled",
                    type: "boolean",
                    value: false,
                    default: true,
                    required: false,
                    description: "Boolean false remains an explicit value",
                  },
                  {
                    name: "rate",
                    label: "Rate",
                    type: "number",
                    value: 0.125,
                    default: 0.25,
                    required: false,
                    description: "Precision-preserving numeric override",
                  },
                ];
          const source = {
            source_id: 8013,
            name: "editable-source",
            team_id: 1,
            mode,
            contract_version: "source.v1",
            implementation_version: "release-1",
            filter_summary: "",
            description: "Source editor state fixture",
            enabled: state !== "disabled",
            revision: 3,
            settings_status:
              state === "awaiting-schema"
                ? "awaiting_schema"
                : state === "incomplete"
                  ? "incomplete"
                  : "complete",
            polling:
              mode === "poller"
                ? {
                    polling_blocked_at:
                      state === "blocked" ? "2026-10-18T00:01:00Z" : null,
                    consecutive_failures: state === "blocked" ? 5 : 0,
                    next_poll_at: [
                      "blocked",
                      "disabled",
                      "incomplete",
                      "awaiting-schema",
                    ].includes(state)
                      ? null
                      : "2026-10-20T12:00:00Z",
                  }
                : null,
          };
          const settings = {
            source_id: source.source_id,
            mode,
            revision: 3,
            settings_status: source.settings_status,
            fields,
            platform: {
              poll_url:
                mode === "poller" ? "https://poller.example/tasks" : null,
              poll_interval_minutes: mode === "poller" ? 5 : null,
              webhook_url:
                mode === "webhook"
                  ? "https://receiver.example/webhook/1/editable-source/task"
                  : null,
            },
          };
          await page.route(
            `**/ui/v1/sources/${source.source_id}`,
            async (route) => {
              if (state === "loading") await held;
              const status =
                state === "unavailable" ? 404 : state === "error" ? 503 : 200;
              await route.fulfill({
                status,
                json:
                  status === 200
                    ? source
                    : {
                        code: status === 404 ? "not_found" : "unavailable",
                      },
              });
            },
          );
          await page.route(
            `**/ui/v1/sources/${source.source_id}/settings`,
            async (route) => {
              if (route.request().method() === "GET")
                return route.fulfill({
                  json: settings,
                  headers: { etag: '"rev-3"' },
                });
              expect(route.request().method()).toBe("PUT");
              expect(route.request().headers()["if-match"]).toBe('"rev-3"');
              expect(route.request().postDataJSON()).toEqual({
                values: {
                  project: "Unsaved project draft",
                  enabled: false,
                  rate: 0.125,
                },
              });
              if (state === "busy") await held;
              if (state === "stale-revision")
                return route.fulfill({
                  status: 412,
                  json: { code: "precondition_failed" },
                });
              await route.fulfill({
                json: {
                  ...settings,
                  revision: 4,
                  fields: fields.map((field) =>
                    field.name === "project"
                      ? { ...field, value: "Unsaved project draft" }
                      : field,
                  ),
                },
                headers: { etag: '"rev-4"' },
              });
            },
          );
          await page.goto(
            `${proxy.baseUrl}?view=source-edit&team=1&id=${source.source_id}`,
          );
          const root = page.locator("#source-editor");
          const save = root.getByRole("button", {
            name: "Save source",
            exact: true,
          });
          if (state === "loading") {
            await expect(root).toContainText("Loading Source settings…");
            await expect(root.locator("form")).toHaveCount(0);
          } else if (["unavailable", "error"].includes(state)) {
            await expect(root.getByRole("alert")).toContainText(
              state === "unavailable"
                ? "not available in this team"
                : "Source settings could not be loaded",
            );
            // Owner review 2026-10-25: as in source-edit.html, a failed read
            // offers a Retry link that reopens this editor; the unavailable
            // Source offers only Open Sources. No in-place button.
            await expect(
              root.getByRole("button", { name: "Retry", exact: true }),
            ).toHaveCount(0);
            if (state === "error")
              await expect(
                root.getByRole("link", { name: "Retry", exact: true }),
              ).toHaveAttribute(
                "href",
                `?view=source-edit&team=1&id=${source.source_id}`,
              );
            else {
              await expect(
                root.getByRole("link", { name: "Retry", exact: true }),
              ).toHaveCount(0);
              await expect(
                root.getByRole("link", { name: "Open Sources", exact: true }),
              ).toBeVisible();
            }
            await expect(save).toHaveCount(0);
            await expect(
              root.locator("form,input,select,textarea"),
            ).toHaveCount(0);
            await expect(root).not.toContainText("Explicit project");
          } else {
            await expect(
              page.getByRole("heading", {
                level: 1,
                name: `Edit source · ${source.name}`,
                exact: true,
              }),
            ).toBeVisible();
            await expect(save).toBeEnabled();
            // Approved editor state line (ui-mockups/source-edit.html).
            const stateLine = root.locator(".editor-state");
            if (state === "blocked")
              expect(
                await stateLine
                  .filter({
                    hasText:
                      "Polling is blocked. Editing settings does not clear the block.",
                  })
                  .isVisible(),
                "Blocked Source notice after synchronous form render",
              ).toBe(true);
            if (state === "incomplete")
              expect(
                await stateLine
                  .filter({
                    hasText:
                      "A required registered setting is missing for intake. The incomplete configuration may still be saved.",
                  })
                  .isVisible(),
                "Incomplete Source notice after synchronous form render",
              ).toBe(true);
            if (state === "disabled")
              await expect(stateLine).toHaveText(
                "This Source is disabled. Editing settings does not enable intake or change its status.",
              );
            if (state === "awaiting-schema") {
              await expect(root).toContainText(
                "Awaiting schema from the implementation",
              );
              await expect(root.locator("[data-source-field]")).toHaveCount(0);
            }
            if (state === "unbound")
              await expect(root).toContainText(
                "No Flow is bound to this Source.",
              );
            else
              await expect(
                root.getByRole("link", {
                  name: "Order flow",
                  exact: true,
                }),
              ).toHaveAttribute("href", "?view=flow&team=1&id=44");
            if (mode === "webhook") {
              await expect(
                root.getByLabel("Poll URL value state", { exact: true }),
              ).toHaveCount(0);
              await expect(root).toContainText(settings.platform.webhook_url!);
            }
            if (state === "invalid") {
              await root
                .getByLabel("Rate override", { exact: true })
                .fill("not-a-number");
              await save.click();
              await expect(root.getByRole("alert")).toHaveText(
                "Rate needs a valid number.",
              );
              await expect(save).toBeEnabled();
            }
            if (state === "unset-values") {
              await root
                .getByLabel("Project value state", { exact: true })
                .selectOption("null");
              await expect(
                root.getByLabel("Project override", { exact: true }),
              ).toBeDisabled();
              await expect(
                root.getByLabel("Enabled override", { exact: true }),
              ).toHaveValue("false");
              await root
                .getByLabel("Rate override", { exact: true })
                .fill("0.1234567890123456789");
              await expect(
                root.getByLabel("Rate override", { exact: true }),
              ).toHaveValue("0.1234567890123456789");
            }
            if (state === "schema-defaults") {
              for (const label of ["Project", "Enabled", "Rate"]) {
                await root
                  .getByLabel(`${label} value state`, { exact: true })
                  .selectOption("default");
                await expect(
                  root.getByLabel(`${label} override`, { exact: true }),
                ).toBeDisabled();
              }
              await expect(root).toContainText(
                "Effective schema default: Schema project",
              );
            }
            if (state === "unbound") {
              // Source has no bound Flow: its settings save on their own.
              await root
                .getByLabel("Project override", { exact: true })
                .fill("Unsaved project draft");
              await save.click();
              await expect.poll(() => writes.length).toBe(1);
              expect(writes[0].path).toBe(
                `/ui/v1/sources/${source.source_id}/settings`,
              );
              expect(
                writes.filter((write) => write.path.startsWith("/ui/v1/flows")),
              ).toEqual([]);
              // Still unbound, and incomplete for intake until a Flow binds it.
              await expect(root).toContainText(
                "No Flow is bound to this Source.",
              );
              await expect(
                root.locator("[data-source-save-status]"),
              ).toContainText(/incomplete for intake|until a Flow/i);
              await expect(
                root.getByRole("link", { name: "Order flow", exact: true }),
              ).toHaveCount(0);
            }
            if (["busy", "stale-revision", "success"].includes(state)) {
              await root
                .getByLabel("Project override", { exact: true })
                .fill("Unsaved project draft");
              await save.click();
              await expect.poll(() => writes.length).toBe(1);
              if (state === "busy") {
                await expect(save).toBeDisabled();
                await expect(
                  root.locator("[data-source-save-status]"),
                ).toHaveText("Saving source…");
              } else if (state === "stale-revision") {
                await expect(root.getByRole("alert")).toContainText(
                  "reload the Source before another Save",
                );
                await expect(save).toBeDisabled();
                await expect(
                  root.getByLabel("Project override", { exact: true }),
                ).toHaveValue("Unsaved project draft");
              } else {
                await expect(
                  root.locator("[data-source-save-status]"),
                ).toHaveText("Source saved. Settings: complete.");
                await expect(save).toBeEnabled();
              }
            }
          }
          expect(writes).toHaveLength(
            ["busy", "stale-revision", "success", "unbound"].includes(state)
              ? 1
              : 0,
          );
          if (await root.locator("#source-settings-form").count()) {
            const actions = root.locator(
              "#source-settings-form > .editor-actions",
            );
            const geometry = await actions.evaluate((bar) => {
              const bounds = bar.getBoundingClientRect();
              return [...bar.children].map((control) => {
                const rect = control.getBoundingClientRect();
                const text = document.createRange();
                text.selectNodeContents(control);
                const lines = [...text.getClientRects()].filter(
                  (line) => line.width > 0 && line.height > 0,
                );
                return {
                  label: control.textContent?.trim(),
                  width: rect.width,
                  height: rect.height,
                  left: rect.left,
                  right: rect.right,
                  barLeft: bounds.left,
                  barRight: bounds.right,
                  barWidth: bounds.width,
                  lines: new Set(lines.map((line) => Math.round(line.top)))
                    .size,
                  textLeft: Math.min(...lines.map((line) => line.left)),
                  textRight: Math.max(...lines.map((line) => line.right)),
                };
              });
            });
            // Approved footer: Save source, then Cancel; Reload Source
            // appears beside the revision note only after a stale result.
            expect(geometry.map((control) => control.label)).toEqual([
              "Save source",
              "Cancel",
            ]);
            await expect(
              root.getByRole("link", { name: "Reload Source", exact: true }),
            ).toHaveCount(state === "stale-revision" ? 1 : 0);
            for (const control of geometry) {
              const label = `${state}/${theme}/${width}/${control.label}`;
              expect(
                control.width,
                `${label} target width`,
              ).toBeGreaterThanOrEqual(44);
              expect(
                control.height,
                `${label} target height`,
              ).toBeGreaterThanOrEqual(44);
              expect(control.lines, `${label} readable action label`).toBe(1);
              expect(
                control.textLeft,
                `${label} visible text left`,
              ).toBeGreaterThanOrEqual(control.left - 1);
              expect(
                control.textRight,
                `${label} visible text right`,
              ).toBeLessThanOrEqual(control.right + 1);
              expect(
                control.left,
                `${label} contained left`,
              ).toBeGreaterThanOrEqual(control.barLeft - 1);
              expect(
                control.right,
                `${label} contained right`,
              ).toBeLessThanOrEqual(control.barRight + 1);
              if (width <= 680)
                expect(
                  Math.abs(control.width - control.barWidth),
                  `${label} mobile full-width action`,
                ).toBeLessThanOrEqual(1);
            }
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await captureDesignState(
            page,
            test.info(),
            proxy.webUIImageID,
            `source-edit.html-${state}-${theme}-${width}`,
          ).catch((error) => censusFailures.push(String(error)));
          captures.push(state);
          if (["loading", "busy"].includes(state)) {
            release();
            if (state === "loading") await expect(save).toBeVisible();
            else
              await expect(
                root.locator("[data-source-save-status]"),
              ).toHaveText("Source saved. Settings: complete.");
          }
        } finally {
          release();
          await page.unrouteAll({ behavior: "wait" });
          await page.close();
        }
      }
      await test.info().attach("approved-source-editor-states", {
        body: JSON.stringify({ theme, width, captures }),
        contentType: "application/json",
      });
      expect(censusFailures).toEqual([]);
    });
