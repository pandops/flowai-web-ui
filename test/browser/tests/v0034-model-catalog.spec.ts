import { contrast } from "../fixtures/contrast";
import { captureDesignState, designViewport } from "../fixtures/design-capture";
import path from "node:path";
import type { Route } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture } from "../fixtures/v0034-flow";

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
  for (const width of [390, 820, 1440]) {
    test(`v0034.7 Model catalog peer metadata and one eligible edge menu ${theme} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      const { writes } = await flowFixture(page);
      const current = {
        name: "first",
        model_alias: "1/first",
        provider: "openai",
        provider_model: "long-custom-provider-model-".repeat(5),
        api_base:
          "https://models.example.test/" + "long-provider-route/".repeat(4),
        created_by: "team",
        model_id: 8008,
        created_at: "2026-10-18T00:00:00Z",
        updated_at: "2026-10-18T00:00:00Z",
        unfinished_task_count: 0,
        archived_at: null,
        editable: true,
        paused: false,
        can_archive: false,
        can_unarchive: false,
        credential_configured: true,
        archive_blocking_flows: [
          {
            flow_id: 8009,
            name: "Order flow",
          },
        ],
        pricing_status: "configured",
        pricing: {
          input_usd_per_million_tokens: "2.5",
          output_usd_per_million_tokens: "10",
        },
      };
      const archived = {
        ...current,
        name: "archived",
        model_id: 8010,
        model_alias: "1/archived",
        paused: true,
        archived_at: "2026-10-18T00:00:00Z",
        can_unarchive: true,
        editable: false,
      };
      const global = {
        ...current,
        name: "global",
        model_id: 8011,
        model_alias: "global/global",
        created_by: "admin",
        editable: false,
      };
      await page.route("**/ui/v1/models?**", (route) =>
        route.fulfill({
          json: {
            items:
              new URL(route.request().url()).searchParams.get("archived") ===
              "true"
                ? [archived]
                : [current, global],
            next_cursor: null,
          },
        }),
      );
      await page.goto(`${proxy.baseUrl}?view=settings&section=models&team=1`);
      const root = page.locator("#models-results");
      await expect(
        root.getByRole("link", { name: "first", exact: true }).first(),
      ).toBeVisible();
      await expect(
        root.locator("th").filter({ hasText: /^Actions$/ }),
      ).toHaveCount(0);
      await expect(root.locator("details")).toHaveCount(0);
      const row = root.locator("tr:visible,article:visible").filter({
        has: page.getByRole("link", { name: "first", exact: true }),
      });
      await expect(row).toHaveCount(1);
      for (const text of [
        current.model_alias,
        current.provider_model,
        current.api_base,
        "alpha",
      ]) {
        const value = row.getByText(text, { exact: true });
        await expect(value).toBeVisible();
        expect(
          await value.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const host = element.closest("tr,article")!.getBoundingClientRect();
            return (
              box.width > 0 &&
              box.left >= host.left &&
              box.right <= host.right + 1 &&
              element.scrollWidth <= element.clientWidth + 1 &&
              element.scrollHeight <= element.clientHeight + 1
            );
          }),
        ).toBe(true);
      }
      await expect(
        row.getByText("2.5 USD per 1M tokens", { exact: true }),
      ).toBeVisible();
      await expect(
        row.getByText("10 USD per 1M tokens", { exact: true }),
      ).toBeVisible();
      const trigger = row.getByRole("button", {
        name: "Actions for first",
        exact: true,
      });
      await expect(trigger).toBeVisible();
      const box = await trigger.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(await row.locator("button:visible").count()).toBe(1);
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      const menu = page.getByRole("menu", {
        name: "Actions for first",
        exact: true,
      });
      await expect(
        menu.getByRole("menuitem", { name: "Edit model", exact: true }),
      ).toBeFocused();
      await expect(
        menu.getByRole("menuitem", { name: "Pause", exact: true }),
      ).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: "Archive", exact: true }),
      ).toBeDisabled();
      await expect(menu).toContainText("Order flow");
      await expect(
        menu.getByRole("link", { name: "Order flow", exact: true }),
      ).toHaveAttribute("href", "?view=flow&team=1&id=8009");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      const readonly = root.locator("tr:visible,article:visible").filter({
        has: page.getByRole("link", { name: "global", exact: true }),
      });
      await expect(readonly.locator("button")).toHaveCount(0);
      const old = page.locator("#archived-models-results");
      await expect(
        old.locator("th").filter({ hasText: /^Actions$/ }),
      ).toHaveCount(0);
      const oldRow = old.locator("tr:visible,article:visible").filter({
        has: page.getByRole("link", { name: "archived", exact: true }),
      });
      await oldRow
        .getByRole("button", { name: "Actions for archived", exact: true })
        .click();
      await expect(
        page
          .getByRole("menu", { name: "Actions for archived", exact: true })
          .getByRole("menuitem", { name: "Unarchive", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      // Canonical inspection uses the same noninteractive badge family as
      // the catalog, including paused and archived identities.
      const detailModels = [
        current,
        {
          ...current,
          name: "paused",
          model_id: 8012,
          model_alias: "1/paused",
          paused: true,
        },
        archived,
      ];
      await page.route("**/ui/v1/models/*", (route) => {
        const name = decodeURIComponent(
          new URL(route.request().url()).pathname.split("/").at(-1)!,
        );
        const detail = detailModels.find((model) => model.name === name);
        return detail && route.request().method() === "GET"
          ? route.fulfill({
              json: detail,
              headers: { etag: '"detail-revision"' },
            })
          : route.fallback();
      });
      for (const detail of detailModels) {
        await page.goto(`${proxy.baseUrl}?view=model&team=1&id=${detail.name}`);
        await expect(
          page
            .locator("#model-view")
            .getByRole("heading", { name: "Model identity", exact: true }),
        ).toBeVisible();
        await expect(
          page
            .locator("#model-view")
            .getByRole("heading", { name: "Status", exact: true }),
        ).toBeVisible();
        const back = await page
          .getByRole("link", { name: "Back to Models", exact: true })
          .boundingBox();
        expect(back).not.toBeNull();
        expect(back!.height).toBeGreaterThanOrEqual(44);
        const status =
          "archived_at" in detail && detail.archived_at
            ? "Archived"
            : detail.paused
              ? "Paused"
              : "Active";
        const badge = page
          .locator("#model-view .metadata > div")
          .filter({ has: page.getByText("Lifecycle", { exact: true }) })
          .locator("dd .badge");
        await expect(badge).toHaveText(status);
        await badge.scrollIntoViewIfNeeded();
        await expect(badge).toBeVisible();
        expect(
          await badge.evaluate((element) =>
            Boolean(
              element.closest(
                'button,a,input,select,textarea,[role="button"],[role="link"],[tabindex]',
              ),
            ),
          ),
        ).toBe(false);
        expect((await badge.boundingBox())!.height).toBeCloseTo(28, 0);
        await expect(
          badge.locator(
            'button,a,input,select,textarea,[role="button"],[role="link"],[tabindex]',
          ),
        ).toHaveCount(0);
        await captureDesignState(
          page,
          test.info(),
          proxy.webUIImageID,
          `model-detail-${status}-${theme}-${width}`,
        );
      }
      const detailStates = [
        { state: "default", model: current },
        { state: "paused", model: detailModels[1] },
        { state: "archived", model: archived },
        {
          state: "pricing-zero",
          model: {
            ...current,
            pricing: {
              input_usd_per_million_tokens: "0",
              output_usd_per_million_tokens: "0",
            },
          },
        },
        {
          state: "pricing-missing",
          model: {
            ...current,
            pricing: null,
            pricing_status: "not_configured",
          },
        },
        {
          state: "pricing-unsupported",
          model: { ...current, pricing: null, pricing_status: "unsupported" },
        },
        { state: "loading", model: current },
        { state: "unavailable", model: { ...current, name: "unknown" } },
        { state: "error", model: current },
      ];
      const captured: string[] = [];
      for (const { state, model } of detailStates) {
        const pattern = `**/ui/v1/models/${model.name}`;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let requests = 0;
        const inFlight: Promise<void>[] = [];
        const failures: unknown[] = [];
        const handler = (route: Route) => {
          requests++;
          const response = (async () => {
            if (state === "loading") await held;
            if (state === "unavailable" || state === "error") {
              await route.fulfill({
                status: state === "unavailable" ? 404 : 503,
                json: {
                  code:
                    state === "unavailable"
                      ? "model_not_found"
                      : "model_gateway_unavailable",
                },
              });
            } else {
              await route.fulfill({
                json: model,
                headers: { etag: '"presentation-revision"' },
              });
            }
          })();
          inFlight.push(response);
          return response;
        };
        await page.route(pattern, handler);
        try {
          await page.goto(
            `${proxy.baseUrl}?view=model&team=1&id=${model.name}`,
          );
          const view = page.locator("#model-view");
          await expect.poll(() => requests).toBe(1);
          if (state === "loading") {
            await expect(view).toContainText("Loading Model…");
            await expect(
              view.getByRole("heading", {
                name: "Model identity",
                exact: true,
              }),
            ).toHaveCount(0);
          } else if (state === "unavailable" || state === "error") {
            await expect(view.getByRole("alert")).toContainText(
              state === "unavailable"
                ? /cannot be shown for the selected team/i
                : /retry or return to the collection/i,
            );
            // Owner review 2026-10-25: model-detail.html offers only the
            // Back to Models link, no in-place Retry command.
            await expect(
              view.getByRole("button", { name: "Retry", exact: true }),
            ).toHaveCount(0);
            await expect(
              view.getByRole("link", { name: "Back to Models", exact: true }),
            ).toBeVisible();
            await expect(
              view.getByRole("heading", {
                name: "Model identity",
                exact: true,
              }),
            ).toHaveCount(0);
            await expect(view).not.toContainText(current.provider_model);
          } else {
            await expect(
              view.getByRole("heading", {
                name: "Model identity",
                exact: true,
              }),
            ).toBeVisible();
            const identity = view
              .locator(".metadata > div")
              .filter({ has: page.getByText("Name", { exact: true }) });
            await expect(identity.locator("dd")).toHaveText(model.name);
            await expect(
              view
                .locator(".metadata > div")
                .filter({ has: page.getByText("Lifecycle", { exact: true }) })
                .locator("dd .badge"),
            ).toHaveText(
              state === "archived"
                ? "Archived"
                : state === "paused"
                  ? "Paused"
                  : "Active",
            );
            if (state === "pricing-missing")
              await expect(
                view.getByText("Not configured", { exact: true }),
              ).toBeVisible();
            if (state === "pricing-unsupported")
              await expect(
                view.getByText("Pricing unavailable", { exact: true }),
              ).toBeVisible();
            if (state === "pricing-zero") {
              await expect(
                view.getByText("0 USD per 1M tokens", { exact: true }),
              ).toHaveCount(2);
              await expect(view).toContainText(
                "No configured input/output token spend: zero token prices do not accumulate token spend, so USD budgets do not limit it; RPM and TPM limits still apply.",
              );
            }
            await expect(
              view.getByRole("link", { name: "Edit model", exact: true }),
            ).toHaveCount(state === "archived" ? 0 : 1);
          }
          await expect(view.locator("input,select,textarea,form")).toHaveCount(
            0,
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          expect(writes).toEqual([]);
          await captureDesignState(
            page,
            test.info(),
            proxy.webUIImageID,
            `model-detail.html-${state}-${theme}-${width}`,
          );
          captured.push(state);
        } catch (error) {
          failures.push(error);
        } finally {
          release();
          for (const result of await Promise.allSettled(inFlight))
            if (result.status === "rejected") failures.push(result.reason);
          try {
            await page.unroute(pattern, handler);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            `Model detail state ${state} or route cleanup failed`,
          );
      }
      await test.info().attach("approved-model-detail-states", {
        body: JSON.stringify({ theme, width, captured }),
        contentType: "application/json",
      });
      await page.goto(`${proxy.baseUrl}?view=settings&section=models&team=1`);
      expect(writes).toEqual([]);
    });
  }

for (const theme of ["dark", "light"] as const)
  for (const [width, height] of [
    [390, 844],
    [820, 1180],
    [1440, 900],
  ]) {
    test(`v0034.12 independent Model editor presentation states ${theme} ${width}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (value) => localStorage.setItem("flowai.theme", value),
        theme,
      );
      const states = [
        "default",
        "paused",
        "credential-required",
        "pricing-missing",
        "pricing-unsupported",
        "pricing-zero",
        "loading",
        "error",
        "unavailable",
        "invalid",
        "invalid-pricing",
        "busy",
        "stale-revision",
        "gateway-unavailable",
        "uncertain",
        "success",
      ];
      const captured: string[] = [];
      const { writes } = await flowFixture(page);
      for (const state of states) {
        writes.length = 0;
        let model = {
          name: "first",
          model_alias: "1/first",
          provider: "openai",
          provider_model: "fixture-provider-model",
          api_base: "https://models.example.test/v1",
          created_by: "team",
          model_id: 8008,
          created_at: "2026-10-18T00:00:00Z",
          updated_at: "2026-10-18T00:00:00Z",
          unfinished_task_count: 0,
          can_archive: true,
          can_unarchive: false,
          archive_blocking_flows: [],
          editable: true,
          paused: state === "paused",
          archived_at: null,
          credential_configured: state !== "credential-required",
          pricing_status:
            state === "pricing-unsupported"
              ? "unsupported"
              : state === "pricing-missing"
                ? "not_configured"
                : "configured",
          pricing: ["pricing-missing", "pricing-unsupported"].includes(state)
            ? null
            : {
                input_usd_per_million_tokens:
                  state === "pricing-zero" ? "0" : "2.5",
                output_usd_per_million_tokens:
                  state === "pricing-zero" ? "0" : "10",
              },
        };
        const sent: { method: string; etag?: string; body: any }[] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const pending: Promise<void>[] = [];
        let reads = 0;
        const handler = (route: Route) => {
          const response = (async () => {
            if (route.request().method() === "GET") {
              reads++;
              if (state === "loading") await held;
              if (["error", "unavailable"].includes(state)) {
                await route.fulfill({
                  status: state === "error" ? 503 : 404,
                  json: {
                    code:
                      state === "error"
                        ? "model_gateway_unavailable"
                        : "model_not_found",
                  },
                });
              } else
                await route.fulfill({
                  json: model,
                  headers: { etag: sent.length ? '"editor-2"' : '"editor-1"' },
                });
              return;
            }
            expect(route.request().method()).toBe("PUT");
            sent.push({
              method: route.request().method(),
              etag: route.request().headers()["if-match"],
              body: route.request().postDataJSON(),
            });
            if (state === "busy") await held;
            if (state === "uncertain") await route.abort("connectionreset");
            else if (["stale-revision", "gateway-unavailable"].includes(state))
              await route.fulfill({
                status: state === "stale-revision" ? 412 : 503,
                json: {
                  code:
                    state === "stale-revision"
                      ? "stale_revision"
                      : "model_gateway_unavailable",
                },
              });
            else {
              model = {
                ...model,
                ...sent[0].body,
                credential_configured: true,
              };
              delete (model as any).api_key;
              await route.fulfill({
                json: model,
                headers: { etag: '"editor-2"' },
              });
            }
          })();
          pending.push(response);
          return response;
        };
        const failures: unknown[] = [];
        await page.route("**/ui/v1/models/first", handler);
        try {
          await page.goto(`${proxy.baseUrl}?view=model-edit&team=1&id=first`);
          const root = page.locator("#model-view");
          const form = root.locator("#standalone-model-form");
          await expect.poll(() => reads).toBe(1);
          if (["loading", "error", "unavailable"].includes(state)) {
            await expect(form).toHaveCount(0);
            if (state === "loading") {
              // The approved loading state is a bare panel under the named
              // editor title (ui-mockups/model-edit.html?state=loading).
              await expect(
                root.getByRole("heading", {
                  name: "Loading model",
                  exact: true,
                }),
              ).toBeVisible();
              await expect(root.getByRole("status")).toContainText(
                "Loading model configuration…",
              );
              await expect(
                page.getByRole("heading", {
                  name: "Edit model · first",
                  exact: true,
                }),
              ).toBeVisible();
            } else {
              await expect(
                root.getByRole("heading", {
                  name: "Model unavailable",
                  exact: true,
                }),
              ).toBeVisible();
              await expect(
                page.getByRole("heading", {
                  name: state === "error" ? "Edit model · first" : "Edit model",
                  exact: true,
                }),
              ).toBeVisible();
              await expect(root.getByRole("alert")).toContainText(
                state === "error"
                  ? /could not be loaded/i
                  : /not available in this team/i,
              );
              // Owner review 2026-10-25: as in model-edit.html, the failed
              // read offers a Retry link that reopens this editor and the
              // unavailable model offers Open Models; no in-place button.
              await expect(
                root.getByRole("button", { name: "Retry", exact: true }),
              ).toHaveCount(0);
              if (state === "error")
                await expect(
                  root.getByRole("link", { name: "Retry", exact: true }),
                ).toHaveAttribute("href", "?view=model-edit&team=1&id=first");
              else
                await expect(
                  root.getByRole("link", { name: "Retry", exact: true }),
                ).toHaveCount(0);
              await expect(root).not.toContainText(model.provider_model);
            }
          } else {
            const save = form.getByRole("button", {
              name: "Save model",
              exact: true,
            });
            await expect(save).toBeEnabled();
            // The approved editor shows the immutable name only in Model
            // identity; the form has no Name control.
            await expect(form.locator('[name="name"]')).toHaveCount(0);
            await expect(
              root
                .locator(".editor-identity > div")
                .filter({ has: page.getByText("Name", { exact: true }) })
                .locator("dd"),
            ).toHaveText("first");
            const key = form.getByLabel("Replacement API key (write-only)", {
              exact: true,
            });
            await expect(key).toHaveValue("");
            const input = form.getByLabel("Input price (USD per 1M tokens)", {
              exact: true,
            });
            const output = form.getByLabel("Output price (USD per 1M tokens)", {
              exact: true,
            });
            for (const field of [input, output])
              await expect(field).toHaveAttribute("required", "");
            if (state === "paused")
              await expect(
                root.locator(".badge").filter({ hasText: /^Paused$/ }),
              ).toBeVisible();
            if (state === "credential-required")
              await expect(root).toContainText(/API key before use/i);
            if (["pricing-missing", "pricing-unsupported"].includes(state)) {
              await expect(input).toHaveValue("");
              await expect(output).toHaveValue("");
              await expect(root).toContainText(
                state === "pricing-missing"
                  ? /pricing is not configured/i
                  : /pricing unavailable/i,
              );
            }
            if (state === "pricing-zero") {
              await expect(input).toHaveValue("0");
              await expect(output).toHaveValue("0");
            }
            if (["invalid", "invalid-pricing"].includes(state)) {
              await key.fill("synthetic-model-invalid-key");
              if (state === "invalid")
                await form
                  .getByLabel("Provider model", { exact: true })
                  .fill("");
              else await input.fill("-1");
              await save.click();
              await expect(form.getByRole("alert")).not.toBeEmpty();
              const errorContrast = await contrast(form.getByRole("alert"));
              expect(
                errorContrast.ratio,
                JSON.stringify(errorContrast),
              ).toBeGreaterThanOrEqual(4.5);
              await expect(key).toHaveValue("");
              await expect(
                state === "invalid"
                  ? form.getByLabel("Provider model", { exact: true })
                  : input,
              ).toBeFocused();
              await expect(
                state === "invalid"
                  ? form.getByLabel("Provider model", { exact: true })
                  : input,
              ).toHaveAttribute("aria-invalid", "true");
              expect(sent).toEqual([]);
            }
            if (
              [
                "busy",
                "stale-revision",
                "gateway-unavailable",
                "uncertain",
                "success",
              ].includes(state)
            ) {
              await form
                .getByLabel("Provider model", { exact: true })
                .fill("saved-provider-model");
              await key.fill("synthetic-model-state-write-key");
              await save.click();
              await expect.poll(() => sent.length).toBe(1);
              expect(sent[0].etag).toBe('"editor-1"');
              expect(sent[0].body.pricing).toEqual(model.pricing);
              if (state === "success") {
                await expect(page).toHaveURL(/view=model&/);
                await expect(
                  root.getByRole("heading", {
                    name: "Model identity",
                    exact: true,
                  }),
                ).toBeVisible();
                await expect(root).toContainText("saved-provider-model");
                await expect(
                  root.locator('input[type="password"]'),
                ).toHaveCount(0);
              } else {
                await expect(save).toBeDisabled();
                await expect(key).toHaveValue("");
                if (state === "busy")
                  await expect(form.getByRole("status")).toContainText(
                    /save is in progress/i,
                  );
                else {
                  await expect(form.getByRole("alert")).toContainText(
                    /reload the model/i,
                  );
                  await expect(
                    form.getByLabel("Provider model", { exact: true }),
                  ).toHaveValue("saved-provider-model");
                  await expect(
                    form.getByRole("link", {
                      name: "Refresh model",
                      exact: true,
                    }),
                  ).toBeVisible();
                  await save.evaluate((button: HTMLButtonElement) =>
                    button.click(),
                  );
                  expect(sent).toHaveLength(1);
                }
              }
            }
          }
          expect(sent).toHaveLength(
            [
              "busy",
              "stale-revision",
              "gateway-unavailable",
              "uncertain",
              "success",
            ].includes(state)
              ? 1
              : 0,
          );
          expect(writes).toEqual(
            sent.map(({ body, etag }) => ({
              path: "/ui/v1/models/first",
              body,
              etag,
            })),
          );
          if (await root.locator("#standalone-model-form").count()) {
            const actions = root.locator(
              "#standalone-model-form > .editor-actions",
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
            expect(geometry.map((control) => control.label)).toEqual([
              "Save model",
              "Cancel",
            ]);
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
          if (state === "success") {
            // The approved success sample (ui-mockups/model-edit.html
            // ?state=success) is the editor after a confirmed save; the
            // runtime returns to Model detail first, so reopen the editor
            // with the saved canonical model for the capture.
            await page.goto(`${proxy.baseUrl}?view=model-edit&team=1&id=first`);
            await expect(
              page
                .locator("#standalone-model-form")
                .getByLabel("Provider model", { exact: true }),
            ).toHaveValue("saved-provider-model");
          }
          await captureDesignState(
            page,
            test.info(),
            proxy.webUIImageID,
            `model-edit.html-${state}-${theme}-${width}`,
          );
          captured.push(state);
          if (state === "busy") {
            release();
            await expect(page).toHaveURL(/view=model&/);
            await expect(
              page
                .locator("#model-view")
                .getByRole("heading", { name: "Model identity", exact: true }),
            ).toBeVisible();
          }
        } catch (error) {
          failures.push(error);
        } finally {
          release();
          try {
            await page.unroute("**/ui/v1/models/first", handler);
          } catch (error) {
            failures.push(error);
          }
          for (const result of await Promise.allSettled(pending))
            if (result.status === "rejected") failures.push(result.reason);
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            `Model editor state ${state} or route cleanup failed`,
          );
      }
      await test.info().attach("approved-model-editor-states", {
        body: JSON.stringify({ theme, width, captured }),
        contentType: "application/json",
      });
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
