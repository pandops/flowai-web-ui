import path from "node:path";
import { cellName, Stage0Cells } from "../fixtures/stage0-cells";
import { flowEditor } from "../fixtures/flow-editor";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture, flowID, aliases } from "../fixtures/v0034-flow";

test.use({ hasTouch: true, actionTimeout: 10_000 });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

// One test per placement so the cells spread over the workers; the
// table_right_cell test keeps the original title.
for (const theme of ["dark", "light"])
  for (const input of ["keyboard", "mouse", "touch"] as const)
    for (const placement of [
      "table_right_cell",
      "card_corner",
      "model_control_band",
    ])
      test(`v0034.12 item command lifecycle product ${theme} ${input}${
        placement === "table_right_cell" ? "" : ` ${placement}`
      }`, async ({ context }) => {
        test.setTimeout(900_000);
        const completed: object[] = [];
        const cells = new Stage0Cells(test.info(), "item_menu");
        for (const commands of [
          "zero_readonly",
          "one",
          "many",
          "disabled_reason",
        ])
          for (const finish of [
            "resize",
            "Escape",
            "outside",
            "scroll_bottom",
            "invoke_once",
          ]) {
            if (
              (placement === "model_control_band" && commands === "many") ||
              (commands === "zero_readonly" && finish === "invoke_once")
            )
              continue;
            const cell = { input, placement, commands, finish, theme };
            const page = await context.newPage();
            const errors: unknown[] = [];
            let release: (() => void) | undefined;
            try {
              await page.setViewportSize(
                placement === "card_corner"
                  ? { width: 390, height: 844 }
                  : { width: 1440, height: 900 },
              );
              const resize = () =>
                page.setViewportSize(
                  placement === "card_corner"
                    ? { width: 820, height: 1180 }
                    : { width: 390, height: 844 },
                );
              await page.addInitScript(
                (value) => localStorage.setItem("flowai.theme", value),
                theme,
              );
              const { writes, flows } = await flowFixture(page);
              if (commands === "disabled_reason")
                flows.get(flowID)!.model_aliases = aliases.slice(0, 1);
              flows.get(flowID)!.prompt_template = "Task instructions\n".repeat(
                120,
              );
              const current = {
                name: "menu-model",
                model_alias:
                  commands === "zero_readonly"
                    ? "global/menu-model"
                    : "1/menu-model",
                provider: "openai",
                provider_model: "fixture",
                created_by: commands === "zero_readonly" ? "admin" : "team",
                editable: commands !== "zero_readonly",
                paused: false,
                can_archive: !["disabled_reason", "zero_readonly"].includes(
                  commands,
                ),
                can_unarchive: false,
                archived_at: null,
                credential_configured: false,
                archive_blocking_flows:
                  commands === "disabled_reason"
                    ? [{ flow_id: flowID, name: "Order flow" }]
                    : [],
                pricing_status: "configured",
                pricing: {
                  input_usd_per_million_tokens: "0.1",
                  output_usd_per_million_tokens: "0.4",
                },
              };
              let archived = {
                ...current,
                name: "archived-menu",
                model_alias: "1/archived-menu",
                created_by: "team",
                editable: false,
                can_archive: false,
                can_unarchive: true,
                archived_at: "2026-10-18T00:00:00Z",
                paused: true,
              };
              const filler = Array.from({ length: 9 }, (_, index) => ({
                ...current,
                name: `zz-model-${index}`,
                model_alias: `global/zz-model-${index}`,
                created_by: "admin",
                editable: false,
                can_archive: false,
                can_unarchive: false,
              }));
              const active = [current, ...filler];
              const old = [
                archived,
                ...filler.map((row) => ({
                  ...row,
                  archived_at: archived.archived_at,
                  paused: true,
                })),
              ];
              await page.route("**/ui/v1/models?**", (route) =>
                route.fulfill({
                  json: {
                    items:
                      new URL(route.request().url()).searchParams.get(
                        "archived",
                      ) === "true"
                        ? old
                        : active,
                    next_cursor: null,
                  },
                }),
              );
              const held = new Promise<void>((resolve) => {
                release = resolve;
              });
              await page.route(
                "**/ui/v1/models/archived-menu/unarchive",
                async (route) => {
                  await held;
                  expect(route.request().headers()["if-match"]).toBe('"1"');
                  archived = {
                    ...archived,
                    archived_at: null,
                    paused: false,
                    can_unarchive: false,
                    editable: true,
                  };
                  old.shift();
                  active.unshift(archived);
                  await route.fulfill({ status: 204 });
                },
              );
              await page.route("**/ui/v1/models/archived-menu", (route) =>
                route.fulfill({
                  json: archived,
                  headers: { etag: archived.archived_at ? '"1"' : '"2"' },
                }),
              );
              await page.route("**/ui/v1/models/menu-model", (route) =>
                route.fulfill({ json: current, headers: { etag: '"1"' } }),
              );
              const band = placement === "model_control_band";
              await page.goto(
                `${proxy.baseUrl}?view=${band ? "flow" : "settings"}&team=1&${band ? `id=${flowID}` : "section=models"}`,
              );
              if (band && commands !== "zero_readonly") {
                await page
                  .getByRole("link", { name: "Edit flow", exact: true })
                  .click();
                await expect(flowEditor(page)).toBeVisible();
              }
              const host = band
                ? page.locator(
                    commands === "zero_readonly"
                      ? "#flow-detail .flow-models"
                      : "#flow-form [data-model-list]",
                  )
                : page.locator(
                    commands === "one"
                      ? "#archived-models-results"
                      : "#models-results",
                  );
              await expect(host).toBeVisible();
              const scrollToBottom = async () => {
                // The approved Flow editor scrolls with the page.
                const scroller = page.locator("html");
                const before = await scroller.evaluate(
                  (element) => element.scrollTop,
                );
                await scroller.evaluate((element) => {
                  element.scrollTop = element.scrollHeight;
                });
                await expect
                  .poll(() =>
                    scroller.evaluate(
                      (element) =>
                        element.scrollTop > 0 &&
                        Math.abs(
                          element.scrollHeight -
                            element.clientHeight -
                            element.scrollTop,
                        ) <= 1,
                    ),
                  )
                  .toBe(true);
                expect(
                  await scroller.evaluate((element) => element.scrollTop),
                  JSON.stringify(cell),
                ).toBeGreaterThan(before);
              };
              const trigger = host
                .locator("[data-command-trigger]:visible")
                .first();
              if (commands === "zero_readonly") {
                await expect(
                  host.locator("[data-command-trigger]"),
                ).toHaveCount(0);
                await expect(host.locator(".command-menu")).toHaveCount(0);
                await expect(
                  host.locator("th").filter({ hasText: /^Actions$/ }),
                ).toHaveCount(0);
              } else {
                await trigger.scrollIntoViewIfNeeded();
                expect(
                  await trigger.evaluate((element) =>
                    element.closest(".flow-model-controls")
                      ? "model_control_band"
                      : element.closest("article")
                        ? "card_corner"
                        : element.closest("tr")
                          ? "table_right_cell"
                          : "unknown",
                  ),
                  JSON.stringify(cell),
                ).toBe(placement);
                await expect(trigger).toHaveAttribute("aria-expanded", "false");
                const id = await trigger.getAttribute("aria-controls");
                const menu = page.locator(`[id="${id}"]`);
                if (input === "keyboard") {
                  await trigger.focus();
                  await page.keyboard.press("ArrowDown");
                } else if (input === "touch") await trigger.tap();
                else await trigger.click();
                await expect(menu).toBeVisible();
                await expect(trigger).toHaveAttribute("aria-expanded", "true");
                const items = menu.getByRole("menuitem");
                await expect(items).toHaveCount(
                  band || commands === "one" ? 1 : 3,
                );
                if (commands === "disabled_reason") {
                  const disabled = items.filter({
                    hasText: band ? /^Remove$/ : /^Archive$/,
                  });
                  await expect(disabled).toBeDisabled();
                  if (band)
                    await expect(disabled).toHaveAttribute(
                      "title",
                      "A Flow needs at least one model.",
                    );
                  else
                    // Approved copy of the disabled Archive reason.
                    await expect(menu).toContainText(
                      "Add another model before archiving.",
                    );
                }
                const before = writes.length;
                if (finish === "Escape") {
                  await page.keyboard.press("Escape");
                  await expect(menu).toBeHidden();
                  await expect(trigger).toBeFocused();
                } else if (finish === "outside") {
                  // An actual non-command target dismisses the native popover.
                  if (input === "touch") await page.touchscreen.tap(5, 5);
                  else await page.mouse.click(5, 5);
                  await expect(menu).toBeHidden();
                } else if (finish === "resize") {
                  await resize();
                } else if (finish === "scroll_bottom") {
                  await scrollToBottom();
                } else if (commands === "disabled_reason") {
                  // Native disabled controls must deny pointer activation; keyboard
                  // navigation must never focus a disabled command.
                  const disabled = items.filter({
                    hasText: band ? /^Remove$/ : /^Archive$/,
                  });
                  if (input === "keyboard") {
                    await page.keyboard.press("End");
                    await expect(disabled).not.toBeFocused();
                  } else {
                    const box = await disabled.boundingBox();
                    if (input === "touch")
                      await page.touchscreen.tap(
                        box!.x + box!.width / 2,
                        box!.y + box!.height / 2,
                      );
                    else
                      await page.mouse.click(
                        box!.x + box!.width / 2,
                        box!.y + box!.height / 2,
                      );
                  }
                  await expect(
                    page.locator("#model-archive-dialog"),
                  ).toBeHidden();
                } else {
                  const command = items.first();
                  if (input === "keyboard") {
                    await command.focus();
                    await page.keyboard.press("Enter");
                  } else if (input === "touch") await command.tap();
                  else await command.click();
                  await expect(menu).toBeHidden();
                  if (band) await expect(host.locator("select")).toHaveCount(2);
                  else if (commands === "one") {
                    const dialog = page.locator("#model-unarchive-dialog");
                    await expect(dialog).toBeVisible();
                    const confirm = dialog.locator('[type="submit"]');
                    const box = await confirm.boundingBox();
                    if (input === "keyboard") {
                      await confirm.focus();
                      await page.keyboard.press("Enter");
                      await page.keyboard.press("Enter");
                    } else if (input === "touch") {
                      await page.touchscreen.tap(
                        box!.x + box!.width / 2,
                        box!.y + box!.height / 2,
                      );
                      await page.touchscreen.tap(
                        box!.x + box!.width / 2,
                        box!.y + box!.height / 2,
                      );
                    } else
                      await page.mouse.dblclick(
                        box!.x + box!.width / 2,
                        box!.y + box!.height / 2,
                      );
                    await expect.poll(() => writes.length).toBe(before + 1);
                    await expect(confirm).toBeDisabled();
                    expect(writes.at(-1)!.path).toBe(
                      "/ui/v1/models/archived-menu/unarchive",
                    );
                    release!();
                    await expect(dialog).toBeHidden();
                    await expect(
                      page.locator("#models-results").getByRole("link", {
                        name: "archived-menu",
                        exact: true,
                      }),
                    ).toBeVisible();
                    await expect(
                      page
                        .locator("#archived-models-results")
                        .getByRole("link", {
                          name: "archived-menu",
                          exact: true,
                        }),
                    ).toHaveCount(0);
                  } else
                    await expect(
                      page.locator("#standalone-model-form"),
                    ).toBeVisible();
                }
                if (["resize", "scroll_bottom"].includes(finish)) {
                  // Closing is allowed; a surviving menu must remain reachable.
                  await expect
                    .poll(async () =>
                      menu.evaluate((element) => {
                        if (!element.matches(":popover-open")) return true;
                        const rect = element.getBoundingClientRect();
                        return (
                          rect.left >= 0 &&
                          rect.top >= 0 &&
                          rect.right <= innerWidth &&
                          rect.bottom <= innerHeight
                        );
                      }),
                    )
                    .toBe(true);
                }
                expect(writes.length, JSON.stringify(cell)).toBe(
                  before +
                    (finish === "invoke_once" && commands === "one" && !band
                      ? 1
                      : 0),
                );
              }
              if (commands === "zero_readonly") {
                if (finish === "Escape") await page.keyboard.press("Escape");
                else if (finish === "outside") await page.mouse.click(5, 5);
                else if (finish === "resize")
                  await resize();
                else await scrollToBottom();
                await expect(
                  host.locator("[data-command-trigger]"),
                ).toHaveCount(0);
                expect(writes).toHaveLength(0);
              }
              completed.push(cell);
            } catch (error) {
              errors.push(error);
            } finally {
              release?.();
              try {
                await page.close();
              } catch (error) {
                errors.push(error);
              }
            }
            // Each cell records its own verdict; later cells still run.
            if (errors.length)
              await cells.fail(
                cell,
                errors.length === 1
                  ? errors[0]
                  : new AggregateError(errors, `Menu cell ${cellName(cell)}`),
              );
            else await cells.record(cellName(cell), true);
          }
        await test.info().attach("item-menu-product", {
          contentType: "application/json",
          body: JSON.stringify(completed),
        });
        cells.finish();
      });
