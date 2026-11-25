import { captureDesignState, designViewport } from "../fixtures/design-capture";
import { Stage0Cells } from "../fixtures/stage0-cells";
import path from "node:path";
import { existsSync } from "node:fs";
import { startBrowserZoom } from "../fixtures/browser_zoom";
import type { CDPSession, Page } from "@playwright/test";
import {
  flowFixture as fixture,
  flowID,
  aliases,
} from "../fixtures/v0034-flow";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Fail missing-control actions before the test deadline, leaving teardown time.
test.use({ actionTimeout: 10_000, trace: "off" });
// Explicit traces retain the existing screenshots except for native lifecycle
// checks, which use DOM snapshots and post-restoration screenshots.
// A case skipped before its hooks (for example after a group block) never
// started tracing, so it must not report a tracing error instead of its skip.
const tracing = new WeakSet<object>();
test.beforeEach(async ({ context }, info) => {
  await context.tracing.start({
    screenshots: !info.title.includes("departure cancels"),
    snapshots: true,
    sources: true,
  });
  tracing.add(context);
});
test.afterEach(async ({ context }, info) => {
  if (!tracing.delete(context)) return;
  const trace = info.outputPath("priority-browser.zip");
  await context.tracing.stop({ path: trace });
  await info.attach("priority-browser-trace", {
    path: trace,
    contentType: "application/zip",
  });
});

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});
// The 210-cell native priority matrix, one test per input and row count so
// its cells spread over the workers; declared first so the longest tests of
// this file start first. Each runs in its own native browser tab with
// Playwright's focus emulation off, as after the visibility qualification.
for (const input of ["keyboard", "mouse", "touch"] as const)
  for (const count of [1, 2, 5] as const)
    test(`v0034.6 native priority lifecycle matrix ${input} ${count} rows`, async () => {
      test.setTimeout(600_000);
      const nativeTrace = test.info().outputPath("native-priority-browser.zip");
      const native = await startBrowserZoom({
        naturalVisibility: true,
        tracePath: nativeTrace,
      });
      const failures: unknown[] = [];
      try {
        const candidate = await native.context.newPage();
        await candidate.bringToFront();
        const state = await fixture(candidate);
        // The grip's 350 ms hold is a page timer. A controllable clock lets
        // the early-motion cells pause it between press and move, so host
        // load cannot let the hold fire before the motion arrives.
        await candidate.clock.install();
        await candidate.goto(
          `${proxy.baseUrl}?view=flows&team=1&id=${flowID}`,
          { timeout: 10_000, waitUntil: "domcontentloaded" },
        );
        await expect(candidate.locator("#flow-form")).toBeVisible({
          timeout: 10_000,
        });
        const client = await native.context.newCDPSession(candidate);
        await client.send("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        await expect
          .poll(() => candidate.evaluate(() => document.visibilityState))
          .toBe("visible");
        await verifyPriorityLifecycleMatrix(
          candidate,
          native,
          state,
          client,
          [input],
          [count],
        );
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await native.close();
        } catch (error) {
          failures.push(error);
        }
        if (existsSync(nativeTrace)) {
          try {
            await test.info().attach("native-priority-browser-trace", {
              path: nativeTrace,
              contentType: "application/zip",
            });
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Native priority matrix failed");
    });

// A merged test runs every step (one per original check) even after a
// failure, keeps each step's own final capture, then fails with all errors.
async function runSteps(
  page: () => Page,
  steps: [string, () => Promise<void>][],
) {
  const failures: unknown[] = [];
  for (const [title, body] of steps)
    await test.step(title, async () => {
      try {
        await body();
      } catch (error) {
        failures.push(error);
      }
      try {
        await captureDesignState(
          page(),
          test.info(),
          proxy.webUIImageID,
          `final-${title}`,
        );
      } catch (error) {
        failures.push(error);
      }
    });
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} steps failed`);
}

const values = (page: Page) =>
  page
    .locator("#flow-form [data-model-list] select")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLSelectElement).value),
    );

test("v0034.6 Flow model list inspection and association guards", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { writes } = await fixture(page);
  await runSteps(
    () => page,
    [
      [
        "v0034.6 Flow inspection shows canonical unnumbered models with aligned badges",
        async () => {
          await page.goto(`${proxy.baseUrl}?view=flow&team=1&id=${flowID}`);
          const rows = page.locator(".flow-models li");
          await expect(rows).toHaveCount(3);
          for (const [index, name] of ["first", "second", "third"].entries()) {
            await expect(
              rows.nth(index).getByRole("link", { name, exact: true }),
            ).toBeVisible();
            await expect(rows.nth(index).locator(".badge")).toHaveText(
              index === 1 ? "Paused" : "Active",
            );
            await expect(rows.nth(index)).not.toContainText(/^[1-5]\./);
          }
          const tracks = await rows.evaluateAll((nodes) =>
            nodes.map((node) => {
              const row = node.getBoundingClientRect(),
                name = node.querySelector("a")!.getBoundingClientRect(),
                badge = node.querySelector(".badge")!.getBoundingClientRect();
              return {
                left: row.left,
                name: name.left,
                status: badge.left,
                badgeHeight: badge.height,
                listLeft: node.parentElement!.getBoundingClientRect().left,
                marker: getComputedStyle(node).listStyleType,
              };
            }),
          );
          expect(
            new Set(tracks.map((track) => Math.round(track.name))).size,
          ).toBe(1);
          expect(
            new Set(tracks.map((track) => Math.round(track.status))).size,
          ).toBe(1);
          for (const track of tracks) {
            expect(track.left).toBeCloseTo(track.listLeft, 0);
            expect(track.name).toBeCloseTo(track.left, 0);
            expect(track.marker).toBe("none");
            expect(track.badgeHeight).toBeCloseTo(28, 0);
          }
        },
      ],
      [
        "v0034.6 model associations retain maximum, minimum and distinct-selection guards",
        async () => {
          await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
          const form = page.locator("#flow-form"),
            add = form.getByRole("button", {
              name: "Add existing model",
              exact: true,
            });
          await add.click();
          await add.click();
          await expect(form.locator("[data-model-list] li")).toHaveCount(5);
          await expect(add).toBeDisabled();
          await form
            .getByRole("button", { name: "Save flow", exact: true })
            .click();
          await expect(form.locator(".validation")).toContainText(
            "Choose one to five models",
          );
          expect(writes).toEqual([]);
          await form
            .locator("[data-model-list] select")
            .nth(3)
            .selectOption(aliases[3]);
          await form
            .locator("[data-model-list] select")
            .last()
            .selectOption(aliases[4]);
          await form
            .locator("[data-model-list] select")
            .last()
            .selectOption(aliases[0]);
          await form
            .getByRole("button", { name: "Save flow", exact: true })
            .click();
          await expect(form.locator(".validation")).toContainText(
            /distinct|duplicate|once|different/i,
          );
          expect(writes).toEqual([]);
          for (let count = 5; count > 1; count--) {
            const row = form.locator("[data-model-list] li").last();
            await row.getByRole("button", { name: /Actions/ }).click();
            await page
              .getByRole("menuitem", { name: "Remove", exact: true })
              .click();
            await expect(form.locator("[data-model-list] li")).toHaveCount(
              count - 1,
            );
          }
          await form
            .locator("[data-model-list] li")
            .getByRole("button", { name: /Actions/ })
            .click();
          await expect(
            page.getByRole("menuitem", { name: "Remove", exact: true }),
          ).toBeDisabled();
          await page.keyboard.press("Escape");
          await expect(add).toBeEnabled();
          expect(writes).toEqual([]);
        },
      ],
    ],
  );
});

for (const theme of ["dark", "light"] as const)
  for (const width of [390, 820, 1440]) {
    test(`v0034.6 keyboard priorities are draft-only, cancellable and saved in existing order ${theme} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (value) => localStorage.setItem("flowai.theme", value),
        theme,
      );
      const { writes } = await fixture(page);
      await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
      const form = page.locator("#flow-form"),
        grip = page.getByRole("button", { name: "Reorder first", exact: true });
      await expect(form).toBeVisible();
      await expect(grip).toBeVisible();
      expect((await grip.boundingBox())!.width).toBeGreaterThanOrEqual(44);
      expect((await grip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(
        (await form.locator("[data-model-list] label").allTextContents()).join(
          " ",
        ),
      ).not.toMatch(/Model [1-5]/);
      const firstRow = form.locator("[data-model-list] li").first();
      const controlBounds = await firstRow
        .locator("button[data-model-grip],select,button[data-command-trigger]")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const r = node.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, height: r.height };
          }),
        );
      expect(controlBounds).toHaveLength(3);
      expect(
        new Set(controlBounds.map((bounds) => Math.round(bounds.top))).size,
      ).toBe(1);
      expect(
        new Set(controlBounds.map((bounds) => Math.round(bounds.bottom))).size,
      ).toBe(1);
      for (const bounds of controlBounds)
        expect(bounds.height).toBeCloseTo(44, 0);
      await grip.focus();
      await grip.press("Space");
      await grip.press("ArrowDown");
      await expect
        .poll(() => values(page))
        .toEqual([aliases[1], aliases[0], aliases[2]]);
      await grip.press("Escape");
      await expect.poll(() => values(page)).toEqual(aliases.slice(0, 3));
      await expect(grip).toBeFocused();
      await grip.press("Enter");
      await grip.press("ArrowDown");
      await grip.press("Enter");
      await expect
        .poll(() => values(page))
        .toEqual([aliases[1], aliases[0], aliases[2]]);
      expect(writes).toEqual([]);
      await grip
        .locator("..")
        .getByRole("button", { name: "Actions for first", exact: true })
        .click();
      await expect(
        page.getByRole("menu", { name: "Actions for first", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      // Cancel is the approved editor's link back to Flows (fixtures/flow-editor.ts).
      await form.getByRole("link", { name: "Cancel", exact: true }).click();
      await page.reload();
      await expect.poll(() => values(page)).toEqual(aliases.slice(0, 3));
      await grip.focus();
      await grip.press("Space");
      await grip.press("ArrowDown");
      await grip.press("ArrowDown");
      await grip.press("Space");
      await expect
        .poll(() => values(page))
        .toEqual([aliases[1], aliases[2], aliases[0]]);
      expect(writes).toEqual([]);
      await form
        .getByRole("button", { name: "Save flow", exact: true })
        .click();
      await expect(form).not.toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        path: `/ui/v1/flows/${flowID}`,
        etag: '"1"',
        body: {
          model_aliases: [aliases[1], aliases[2], aliases[0]],
          source_ids: [],
          source_revisions: {},
        },
      });
      expect(writes[0].body).not.toHaveProperty("priority");
      expect(writes[0].body).not.toHaveProperty("source_settings");
      await page.reload();
      await expect
        .poll(() => values(page))
        .toEqual([aliases[1], aliases[2], aliases[0]]);
    });
  }

test("v0034.6 pointer hold prioritization: drop, early movement, outside, cancel", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(designViewport(1440));
  const { writes } = await fixture(page);
  const gesture = async (
    outcome: "drop" | "early movement" | "outside" | "cancel",
  ) => {
    // A fresh navigation resets the draft and the recorded pointer events.
    await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
    await page.evaluate(() => {
      (window as any).__priorityEvents = [];
      for (const type of [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
        "gotpointercapture",
        "lostpointercapture",
      ])
        document.addEventListener(
          type,
          (event) => {
            const target = event.target as HTMLElement;
            (window as any).__priorityEvents.push({
              type,
              target: target.tagName,
              grip: target.hasAttribute("data-model-grip"),
              pressed: target.getAttribute("aria-pressed"),
              values: [
                ...document.querySelectorAll<HTMLSelectElement>(
                  "[data-model-list] select",
                ),
              ].map((node) => node.value),
            });
          },
          true,
        );
    });
    const grip = page.getByRole("button", {
      name: "Reorder first",
      exact: true,
    });
    await expect(grip).toBeVisible();
    await grip.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const start = (await grip.boundingBox())!,
      target = (await page
        .locator("#flow-form [data-model-list] li")
        .nth(2)
        .boundingBox())!;
    expect(
      await page.evaluate(
        ({ x, y, alias }) =>
          document
            .elementFromPoint(x, y)
            ?.closest("li")
            ?.querySelector("select")?.value === alias,
        {
          x: target.x + target.width / 2,
          y: target.y + target.height / 2,
          alias: aliases[2],
        },
      ),
    ).toBe(true);
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    if (outcome !== "early movement") await page.waitForTimeout(375);
    await page.mouse.move(
      target.x + target.width / 2,
      target.y + target.height / 2,
      { steps: 4 },
    );
    if (outcome === "early movement") await page.waitForTimeout(375);
    if (outcome === "outside") await page.mouse.move(1, 1);
    if (outcome === "cancel") await page.keyboard.press("Escape");
    await page.mouse.up();
    await test.info().attach("priority-gesture", {
      body: JSON.stringify(
        await page.evaluate(() => (window as any).__priorityEvents),
      ),
      contentType: "application/json",
    });
    await expect
      .poll(() => values(page))
      .toEqual(
        outcome === "drop"
          ? [aliases[1], aliases[2], aliases[0]]
          : aliases.slice(0, 3),
      );
    expect(writes).toEqual([]);
    await expect(grip).toBeFocused();
  };
  await runSteps(
    () => page,
    (["drop", "early movement", "outside", "cancel"] as const).map(
      (outcome) => [
        `v0034.6 pointer hold prioritization ${outcome}`,
        async () => {
          try {
            await gesture(outcome);
          } catch (error) {
            // A failed gesture must not leave the button down for the next step.
            await page.mouse.up().catch(() => {});
            throw error;
          }
        },
      ],
    ),
  );
});

test.describe("touch model prioritization", () => {
  test.use({ hasTouch: true, viewport: designViewport(390) });
  test("v0034.6 touch prioritization: hold drop, cancel, early movement and scrolling outside the grip", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { writes } = await fixture(page);
    const hold = async (outcome: "drop" | "cancel" | "early movement") => {
      // A fresh navigation resets the draft; each gesture has its own CDP session.
      await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
      const grip = page.getByRole("button", {
        name: "Reorder first",
        exact: true,
      });
      // Expose the entire three-row list before the direct drop gesture.
      // A clipped target belongs to the separate edge-scroll qualification.
      await page
        .locator("#flow-form [data-model-list]")
        .scrollIntoViewIfNeeded();
      await grip.scrollIntoViewIfNeeded();
      const start = (await grip.boundingBox())!,
        target = (await page
          .locator("#flow-form [data-model-list] li")
          .nth(2)
          .boundingBox())!;
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest("li")
              ?.querySelector("select")?.value,
          { x: target.x + target.width / 2, y: target.y + target.height / 2 },
        ),
      ).toBe(aliases[2]);
      const client = await page.context().newCDPSession(page);
      const point = (x: number, y: number) => [
        { x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
      ];
      let touchActive = false;
      try {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: point(
            start.x + start.width / 2,
            start.y + start.height / 2,
          ),
        });
        touchActive = true;
        if (outcome !== "early movement")
          await expect(grip).toHaveAttribute("aria-pressed", "true");
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: point(
            target.x + target.width / 2,
            target.y + target.height / 2,
          ),
        });
        if (outcome === "early movement") await page.waitForTimeout(375);
        await client.send("Input.dispatchTouchEvent", {
          type: outcome === "cancel" ? "touchCancel" : "touchEnd",
          touchPoints: [],
        });
        touchActive = false;
        await expect
          .poll(() => values(page))
          .toEqual(
            outcome === "drop"
              ? [aliases[1], aliases[2], aliases[0]]
              : aliases.slice(0, 3),
          );
        expect(writes).toEqual([]);
        if (outcome !== "early movement") await expect(grip).toBeFocused();
      } finally {
        if (touchActive)
          await client.send("Input.dispatchTouchEvent", {
            type: "touchCancel",
            touchPoints: [],
          });
        await client.detach();
      }
    };
    const scrollOutside = async () => {
      await page.setViewportSize(designViewport(390));
      await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
      // The approved editor is a normally scrolling page of section cards.
      await expect(page.locator("#flow-form")).toBeVisible();
      const pageScroll = () =>
        page.evaluate(() => document.scrollingElement!.scrollTop);
      await page.evaluate(() => {
        document.scrollingElement!.scrollTop = 0;
      });
      const viewport = page.viewportSize()!,
        initial = await pageScroll();
      const client = await page.context().newCDPSession(page),
        x = viewport.width - 20,
        y = viewport.height - 30;
      const points = (at: number) => [
        { x, y: at, id: 1, radiusX: 4, radiusY: 4, force: 1 },
      ];
      let touchActive = false;
      try {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: points(y),
        });
        touchActive = true;
        for (let step = 1; step <= 6; step++) {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: points(y - step * 18),
          });
          await page.waitForTimeout(16);
        }
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        touchActive = false;
        await expect.poll(pageScroll).toBeGreaterThan(initial + 20);
        await expect.poll(() => values(page)).toEqual(aliases.slice(0, 3));
        expect(writes).toEqual([]);
      } finally {
        if (touchActive)
          await client.send("Input.dispatchTouchEvent", {
            type: "touchCancel",
            touchPoints: [],
          });
        await client.detach();
      }
    };
    await runSteps(
      () => page,
      [
        ...(["drop", "cancel", "early movement"] as const).map(
          (outcome) =>
            [
              `v0034.6 touch hold prioritization ${outcome}`,
              () => hold(outcome),
            ] as [string, () => Promise<void>],
        ),
        [
          "v0034.6 touch scrolling outside the grip preserves the model draft",
          scrollOutside,
        ],
      ],
    );
  });
});

test("v0034.6 keyboard priority boundaries and polite announcements preserve exact selection identity", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { writes } = await fixture(page);
  await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
  const form = page.locator("#flow-form"),
    grip = form.getByRole("button", { name: "Reorder first", exact: true });
  await grip.focus();
  await grip.press("Space");
  const announcement = form
    .locator('[aria-live="polite"]')
    .filter({ hasText: /first/i });
  await expect(announcement).toContainText(/1.*3/);
  await grip.press("ArrowUp");
  await expect.poll(() => values(page)).toEqual(aliases.slice(0, 3));
  await expect(announcement).toContainText(/1.*3/);
  await grip.press("ArrowDown");
  await grip.press("ArrowDown");
  await expect(announcement).toContainText(/3.*3/);
  await grip.press("ArrowDown");
  await expect
    .poll(() => values(page))
    .toEqual([aliases[1], aliases[2], aliases[0]]);
  await grip.press("ArrowUp");
  await expect
    .poll(() => values(page))
    .toEqual([aliases[1], aliases[0], aliases[2]]);
  await expect(announcement).toContainText(/2.*3/);
  await grip.press("Enter");
  await expect(grip).toBeFocused();
  const selected = form
    .locator("[data-model-list] li")
    .nth(1)
    .getByLabel("Model", { exact: true });
  await expect(selected).toHaveValue(aliases[0]);
  expect(writes).toEqual([]);
  const matrix: Record<string, unknown>[] = [];
  for (const count of [1, 2, 5])
    for (const edge of count === 5
      ? ["first", "middle", "last"]
      : ["first", "last"])
      for (const theme of ["dark", "light"])
        for (const width of [390, 820, 1440]) {
          const context = await page
            .context()
            .browser()!
            .newContext({
              viewport: {
                width,
                height: width === 390 ? 844 : width === 820 ? 1180 : 900,
              },
            });
          const contextFailures: unknown[] = [];
          const contextTrace = test
            .info()
            .outputPath(`keyboard-${count}-${edge}-${theme}-${width}.zip`);
          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true,
            });
            await context.addInitScript(
              (value) => localStorage.setItem("flowai.theme", value),
              theme,
            );
            const candidate = await context.newPage();
            const state = await fixture(candidate);
            const original = aliases.slice(0, count);
            state.flows.get(flowID)!.model_aliases = [...original];
            await candidate.goto(
              `${proxy.baseUrl}?view=flows&team=1&id=${flowID}`,
            );
            const target =
              edge === "first"
                ? 0
                : edge === "middle"
                  ? Math.floor(count / 2)
                  : count - 1;
            const source = target === 0 ? count - 1 : 0;
            const name = original[source].split("/")[1];
            const handle = candidate.getByRole("button", {
              name: `Reorder ${name}`,
              exact: true,
            });
            const expected = [...original];
            expected.splice(source, 1);
            expected.splice(target, 0, original[source]);
            const move = async () => {
              for (let i = source; i > target; i--)
                await handle.press("ArrowUp");
              for (let i = source; i < target; i++)
                await handle.press("ArrowDown");
              // At either edge another outward arrow cannot wrap or lose identity.
              if (edge !== "middle")
                await handle.press(edge === "first" ? "ArrowUp" : "ArrowDown");
              await expect.poll(() => values(candidate)).toEqual(expected);
            };
            await handle.focus();
            await handle.press("Space");
            await expect(handle).toHaveAttribute("aria-pressed", "true");
            await move();
            await handle.press("Escape");
            await expect.poll(() => values(candidate)).toEqual(original);
            await expect(handle).toBeFocused();
            expect(state.writes).toEqual([]);
            await handle.press("Enter");
            await move();
            await handle.press("Enter");
            await expect(handle).toBeFocused();
            await expect.poll(() => values(candidate)).toEqual(expected);
            expect(state.writes).toEqual([]);
            await candidate
              .locator("#flow-form")
              .getByRole("button", { name: "Save flow", exact: true })
              .click();
            await expect(candidate.locator("#flow-form")).not.toBeVisible();
            expect(state.writes).toHaveLength(1);
            expect(state.writes[0]).toMatchObject({
              path: `/ui/v1/flows/${flowID}`,
              etag: '\"1\"',
              body: { model_aliases: expected },
            });
            await candidate.reload();
            await expect.poll(() => values(candidate)).toEqual(expected);
            matrix.push({
              count,
              edge,
              theme,
              width,
              original,
              expected,
              writes: state.writes.length,
              cancelled: true,
              saved: true,
            });
          } catch (error) {
            contextFailures.push(error);
          } finally {
            try {
              await context.tracing.stop({ path: contextTrace });
              await test
                .info()
                .attach(`keyboard-${count}-${edge}-${theme}-${width}-trace`, {
                  path: contextTrace,
                  contentType: "application/zip",
                });
            } catch (error) {
              contextFailures.push(error);
            }
            try {
              await context.close();
            } catch (error) {
              contextFailures.push(error);
            }
          }
          if (contextFailures.length)
            throw new AggregateError(
              contextFailures,
              "Keyboard matrix context failed",
            );
        }
  expect(matrix).toHaveLength(42);
  await test.info().attach("keyboard-one-two-five-row-boundaries", {
    contentType: "application/json",
    body: JSON.stringify({ expected: 42, matrix }),
  });
});

async function verifyPriorityLifecycleMatrix(
  page: Page,
  native: Awaited<ReturnType<typeof startBrowserZoom>>,
  state: Awaited<ReturnType<typeof fixture>>,
  client: CDPSession,
  inputs: readonly ("keyboard" | "mouse" | "touch")[],
  counts: readonly (1 | 2 | 5)[] = [1, 2, 5],
) {
  const matrix: Array<Record<string, unknown>> = [];
  const cells = new Stage0Cells(test.info(), "model_reorder");
  try {
    for (const input of inputs)
      for (const count of counts)
        for (const edge of count === 5
          ? ["first", "middle", "last", "scroll_boundary"]
          : ["first", "last", "scroll_boundary"])
          for (const finish of [
            "valid_drop",
            "outside_drop",
            "early_motion",
            "pointer_cancel",
            "Escape",
            "hidden_document",
            "pagehide",
          ] as const)
            await cells.run(
              {
                input,
                rows: count === 1 ? "one" : count === 2 ? "two" : "five",
                finish,
                edge,
              },
              async () => {
                const original = aliases.slice(0, count);
                Object.assign(state.flows.get(flowID)!, {
                  model_aliases: [...original],
                  revision: 1,
                  name: "Order flow",
                });
                state.writes.length = 0;
                // Use the phone for the scroll-boundary interaction.
                await page.setViewportSize(
                  edge === "scroll_boundary"
                    ? designViewport(390)
                    : designViewport(1440),
                );
                const url = `${proxy.baseUrl}?view=flows&team=1&id=${flowID}`;
                await page.goto(url);
                await page.bringToFront();
                const form = page.locator("#flow-form");
                const draft = `Unsaved ${input} ${count} ${edge} ${finish}`;
                await form.getByLabel("Name", { exact: true }).fill(draft);
                const target =
                  edge === "first" ? 0 : edge === "middle" ? 2 : count - 1;
                const source = target === 0 ? count - 1 : 0;
                const handle = form.getByRole("button", {
                  name: `Reorder ${original[source].split("/")[1]}`,
                  exact: true,
                });
                const expected = [...original];
                expected.splice(source, 1);
                expected.splice(target, 0, original[source]);
                await page.evaluate(() => {
                  (window as any).__matrixPointerEvents = [];
                  for (const type of ["pointerdown", "pointercancel"])
                    document.addEventListener(type, (event) => {
                      const pointer = event as PointerEvent;
                      (window as any).__matrixPointerEvents.push({
                        type,
                        pointerType: pointer.pointerType,
                        trusted: pointer.isTrusted,
                        scrollTop: document.scrollingElement!.scrollTop,
                      });
                    });
                  localStorage.removeItem("flowai.test.priority.pagehide");
                  window.addEventListener(
                    "pagehide",
                    (event) => {
                      localStorage.setItem(
                        "flowai.test.priority.pagehide",
                        JSON.stringify({
                          trusted: event.isTrusted,
                          values: [
                            ...document.querySelectorAll<HTMLSelectElement>(
                              "#flow-form [data-model-list] select",
                            ),
                          ].map((node) => node.value),
                        }),
                      );
                    },
                    { once: true },
                  );
                });
                // Prepare the interaction region with ordinary page scrolling;
                // the list scrolls with the page and native edge scrolling
                // moves the page.
                const initialList = form.locator("[data-model-list]");
                const pageScroll = () =>
                  page.evaluate(() => document.scrollingElement!.scrollTop);
                // The visible region lies below the sticky phone header.
                const visibleRegion = async () => {
                  const headerBottom = await page.evaluate(() => {
                    const header = document.querySelector(".mobile-bar");
                    return header &&
                      getComputedStyle(header).position === "sticky"
                      ? Math.max(0, header.getBoundingClientRect().bottom)
                      : 0;
                  });
                  return {
                    y: headerBottom,
                    height: page.viewportSize()!.height - headerBottom,
                  };
                };
                await initialList.scrollIntoViewIfNeeded();
                await handle.scrollIntoViewIfNeeded();
                if (edge === "scroll_boundary")
                  // Keep the source grip in view and let the list run past
                  // the viewport edge on the target side.
                  await page.evaluate(
                    ({ name, down }) => {
                      const grip = document.querySelector(
                        `#flow-form [data-model-grip][aria-label="Reorder ${name}"]`,
                      )!;
                      const header = document.querySelector(".mobile-bar");
                      const top = header
                        ? Math.max(0, header.getBoundingClientRect().bottom)
                        : 0;
                      const box = grip.getBoundingClientRect();
                      scrollBy(
                        0,
                        down ? box.top - Math.max(top + 8, innerHeight - 180) : box.bottom - innerHeight + 8,
                      );
                    },
                    {
                      name: original[source].split("/")[1],
                      down: target > source,
                    },
                  );
                await expect(handle).toBeInViewport();
                const initialListScroll = await pageScroll();
                let pointerMode: "mouse" | "touch" =
                  input === "touch" ? "touch" : "mouse";
                let mouseDown = false,
                  touchDown = false,
                  takeoverRestored = false;
                let nativeScroll = 0;
                let pointerStartScroll = initialListScroll;
                const pointerPhases: Array<Record<string, unknown>> = [];
                const touchPoints = (x: number, y: number) => [
                  { x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
                ];
                const movePointer = async (x: number, y: number) => {
                  if (pointerMode === "touch")
                    await client.send("Input.dispatchTouchEvent", {
                      type: "touchMove",
                      touchPoints: touchPoints(x, y),
                    });
                  else await page.mouse.move(x, y);
                };
                const startPointer = async (mode: "mouse" | "touch") => {
                  pointerMode = mode;
                  await client.send("Emulation.setTouchEmulationEnabled", {
                    enabled: mode === "touch",
                    maxTouchPoints: 1,
                  });
                  const bounds = (await handle.boundingBox())!;
                  const point = {
                    x: bounds.x + bounds.width / 2,
                    y: bounds.y + bounds.height / 2,
                  };
                  if (mode === "touch") {
                    await client.send("Input.dispatchTouchEvent", {
                      type: "touchStart",
                      touchPoints: touchPoints(point.x, point.y),
                    });
                    touchDown = true;
                  } else {
                    await page.mouse.move(point.x, point.y);
                    await page.mouse.down();
                    mouseDown = true;
                  }
                  const down = await page.evaluate(() =>
                    (window as any).__matrixPointerEvents
                      .filter((event: any) => event.type === "pointerdown")
                      .at(-1),
                  );
                  expect(down).toMatchObject({
                    pointerType: mode,
                    trusted: true,
                  });
                  pointerStartScroll = down.scrollTop;
                  nativeScroll = 0;
                  pointerPhases.push({ mode, startScroll: pointerStartScroll });
                  return point;
                };
                const releasePointer = async () => {
                  if (pointerMode === "touch" && touchDown) {
                    await client.send("Input.dispatchTouchEvent", {
                      type: "touchEnd",
                      touchPoints: [],
                    });
                    touchDown = false;
                  } else if (pointerMode === "mouse" && mouseDown) {
                    await page.mouse.up();
                    mouseDown = false;
                  }
                };
                const moveToExpected = async () => {
                  await expect(handle).toHaveAttribute("aria-pressed", "true");
                  const list = form.locator("[data-model-list]");
                  const targetRow = list.locator("li").filter({
                    has: page.locator(
                      `select:has(option[value="${original[target]}"]:checked)`,
                    ),
                  });
                  let reached = false;
                  const samples: Array<Record<string, unknown>> = [];
                  for (let step = 0; step < 30; step++) {
                    const row = (await targetRow.boundingBox())!;
                    const bounds = (await list.boundingBox())!;
                    const editor = await visibleRegion();
                    samples.push({
                      step,
                      row,
                      bounds,
                      editor,
                      page: await page.evaluate(() => ({
                        top: document.scrollingElement!.scrollTop,
                        height: innerHeight,
                        content: document.scrollingElement!.scrollHeight,
                      })),
                      order: await values(page),
                    });
                    const top = Math.max(0, bounds.y, editor.y);
                    const bottom = Math.min(
                      page.viewportSize()!.height,
                      bounds.y + bounds.height,
                      editor.y + editor.height,
                    );
                    // Native edge scrolling may already have moved the lifted
                    // row into its final slot. Hit-test that row before moving
                    // again rather than requiring the displaced neighbor there.
                    const lifted = (await handle.boundingBox())!;
                    if (
                      JSON.stringify(await values(page)) ===
                        JSON.stringify(expected) &&
                      lifted.y + lifted.height / 2 > top &&
                      lifted.y + lifted.height / 2 < bottom
                    ) {
                      await movePointer(
                        lifted.x + lifted.width / 2,
                        lifted.y + lifted.height / 2,
                      );
                      reached = true;
                      break;
                    }
                    const aimX = row.x + row.width / 2;
                    const aimY =
                      row.y + row.height * (source < target ? 0.75 : 0.25);
                    if (aimY > top + 2 && aimY < bottom - 2) {
                      expect(
                        await page.evaluate(
                          ({ x, y }) =>
                            document
                              .elementFromPoint(x, y)
                              ?.closest("li")
                              ?.querySelector("select")?.value,
                          { x: aimX, y: aimY },
                        ),
                      ).toBe(original[target]);
                      await movePointer(aimX, aimY);
                      reached = true;
                      break;
                    }
                    const before = await pageScroll();
                    await movePointer(
                      bounds.x + bounds.width / 2,
                      aimY < top ? top + 8 : bottom - 8,
                    );
                    await page.waitForTimeout(100);
                    nativeScroll += Math.abs((await pageScroll()) - before);
                  }
                  if (!reached)
                    await test.info().attach("priority-unreachable-target", {
                      contentType: "application/json",
                      body: JSON.stringify({
                        input,
                        count,
                        edge,
                        finish,
                        original,
                        expected,
                        samples,
                      }),
                    });
                  expect(
                    reached,
                    `${input}/${count}/${edge}/${finish}: visible native drop target`,
                  ).toBe(true);
                  // Compare only this pointer phase, after the app handled pointerdown.
                  nativeScroll = Math.max(
                    nativeScroll,
                    Math.abs((await pageScroll()) - pointerStartScroll),
                  );
                  Object.assign(pointerPhases.at(-1)!, {
                    endScroll: await pageScroll(),
                    displacement: nativeScroll,
                  });
                  if (count === 5 && edge === "scroll_boundary")
                    expect(nativeScroll).toBeGreaterThan(0);
                  await expect.poll(() => values(page)).toEqual(expected);
                  await expect(handle).toBeInViewport();
                };
                // Early motion means motion inside the hold delay. Freeze the
                // page clock before the press, so the press, the round trips
                // that verify it and the motion all happen at one page time
                // however slow the host is; then run the clock past the delay.
                let clockPaused = false;
                const pauseHold = async () => {
                  const now = await page.evaluate(() => Date.now());
                  await page.clock.pauseAt(now + 1_000);
                  clockPaused = true;
                };
                const resumeClock = async () => {
                  if (!clockPaused) return;
                  clockPaused = false;
                  await page.clock.resume();
                };
                const earlyMovement = async (point: {
                  x: number;
                  y: number;
                }) => {
                  expect(
                    clockPaused,
                    "early motion runs on a paused clock",
                  ).toBe(true);
                  await movePointer(point.x + 16, point.y);
                  // Beyond activation delay: early motion must have cleared the hold.
                  await page.clock.runFor(375);
                  await resumeClock();
                  await expect(handle).toHaveAttribute("aria-pressed", "false");
                  await expect.poll(() => values(page)).toEqual(original);
                };
                const errors: unknown[] = [];
                let initialProvisional = [...original];
                let initialProvisionalScroll = initialListScroll;
                let finishingProvisionalScroll = initialListScroll;
                try {
                  if (input === "keyboard") {
                    await handle.press("Space");
                    for (
                      let i = source;
                      i !== target;
                      i += source < target ? 1 : -1
                    )
                      await handle.press(
                        source < target ? "ArrowDown" : "ArrowUp",
                      );
                    await expect.poll(() => values(page)).toEqual(expected);
                    await expect(handle).toHaveAttribute(
                      "aria-pressed",
                      "true",
                    );
                    await expect(handle).toBeInViewport();
                    initialProvisional = [...expected];
                  } else {
                    if (finish === "early_motion") await pauseHold();
                    const point = await startPointer(input);
                    if (finish === "early_motion") await earlyMovement(point);
                    else {
                      await moveToExpected();
                      initialProvisional = [...expected];
                    }
                  }
                  initialProvisionalScroll = await pageScroll();
                  // Pointer-only finishes after keyboard activation exercise a real
                  // pointer takeover. Mouse cancellation uses an actual touch
                  // takeover and trusted touchCancel, never a synthetic DOM event.
                  const takeover =
                    (input === "keyboard" &&
                      [
                        "outside_drop",
                        "early_motion",
                        "pointer_cancel",
                      ].includes(finish)) ||
                    (input === "mouse" && finish === "pointer_cancel");
                  if (takeover) {
                    if (finish === "early_motion") await pauseHold();
                    const point = await startPointer(
                      finish === "pointer_cancel" ? "touch" : "mouse",
                    );
                    await expect.poll(() => values(page)).toEqual(original);
                    takeoverRestored = true;
                    expect(state.writes).toEqual([]);
                    if (finish === "early_motion") await earlyMovement(point);
                    else await moveToExpected();
                  }
                  finishingProvisionalScroll = await pageScroll();
                  expect(state.writes).toEqual([]);
                  if (finish === "valid_drop") {
                    if (input === "keyboard") await handle.press("Enter");
                    else await releasePointer();
                    await expect(handle).toHaveAttribute(
                      "aria-pressed",
                      "false",
                    );
                    await expect.poll(() => values(page)).toEqual(expected);
                    expect(state.writes).toEqual([]);
                    await form
                      .getByRole("button", { name: "Save flow", exact: true })
                      .click();
                    await expect(form).not.toBeVisible();
                    expect(state.writes).toHaveLength(1);
                    expect(state.writes[0]).toMatchObject({
                      path: `/ui/v1/flows/${flowID}`,
                      etag: '"1"',
                      body: { name: draft, model_aliases: expected },
                    });
                    expect(state.writes[0].body).not.toHaveProperty(
                      "source_settings",
                    );
                  } else if (finish === "outside_drop") {
                    await movePointer(1, 1);
                    await releasePointer();
                  } else if (finish === "pointer_cancel") {
                    await client.send("Input.dispatchTouchEvent", {
                      type: "touchCancel",
                      touchPoints: [],
                    });
                    touchDown = false;
                    expect(
                      await page.evaluate(
                        () => (window as any).__matrixPointerEvents,
                      ),
                    ).toContainEqual(
                      expect.objectContaining({
                        type: "pointercancel",
                        pointerType: "touch",
                        trusted: true,
                      }),
                    );
                  } else if (finish === "Escape") {
                    await page.keyboard.press("Escape");
                  } else if (finish === "hidden_document") {
                    await page.evaluate(() => {
                      (window as any).__matrixHidden = [];
                      document.addEventListener("visibilitychange", (event) =>
                        (window as any).__matrixHidden.push({
                          state: document.visibilityState,
                          trusted: event.isTrusted,
                        }),
                      );
                    });
                    const transition = await native.switchToBlankTab(
                      page.url(),
                    );
                    try {
                      await expect
                        .poll(() =>
                          page.evaluate(() => document.visibilityState),
                        )
                        .toBe("hidden");
                      expect(
                        await page.evaluate(
                          () => (window as any).__matrixHidden,
                        ),
                      ).toContainEqual({ state: "hidden", trusted: true });
                      await expect.poll(() => values(page)).toEqual(original);
                      await expect(
                        form.getByLabel("Name", { exact: true }),
                      ).toHaveValue(draft);
                    } catch (error) {
                      errors.push(error);
                    } finally {
                      try {
                        expect(await transition.restore()).toBe(true);
                      } catch (error) {
                        errors.push(error);
                      }
                    }
                  } else if (finish === "pagehide") {
                    await page.goto(
                      `${proxy.baseUrl}?view=settings&section=parameters&team=1`,
                    );
                    expect(
                      await page.evaluate(() =>
                        JSON.parse(
                          localStorage.getItem(
                            "flowai.test.priority.pagehide",
                          )!,
                        ),
                      ),
                    ).toEqual({ trusted: true, values: original });
                  }
                  if (finish !== "valid_drop" && finish !== "pagehide") {
                    await expect.poll(() => values(page)).toEqual(original);
                    await expect(handle).toHaveAttribute(
                      "aria-pressed",
                      "false",
                    );
                    await expect(handle).toBeInViewport();
                    await expect(
                      form.getByLabel("Name", { exact: true }),
                    ).toHaveValue(draft);
                    await expect.poll(pageScroll).toBe(initialListScroll);
                  }
                } catch (error) {
                  errors.push(error);
                } finally {
                  try {
                    await resumeClock();
                  } catch (error) {
                    errors.push(error);
                  }
                  if (touchDown) {
                    try {
                      await client.send("Input.dispatchTouchEvent", {
                        type: "touchCancel",
                        touchPoints: [],
                      });
                    } catch (error) {
                      errors.push(error);
                    }
                  }
                  if (mouseDown) {
                    try {
                      await page.mouse.up();
                    } catch (error) {
                      errors.push(error);
                    }
                  }
                }
                if (errors.length) {
                  await test.info().attach("priority-failed-matrix-cell", {
                    contentType: "application/json",
                    body: JSON.stringify({
                      input,
                      count,
                      edge,
                      finish,
                      original,
                      expected,
                      initialProvisional,
                      finishingInput: takeoverRestored ? pointerMode : input,
                      takeoverRestored,
                      nativeScroll,
                      pointerPhases,
                    }),
                  });
                  throw new AggregateError(
                    errors,
                    "Native priority matrix cell failed",
                  );
                }
                const persisted = finish === "valid_drop" ? expected : original;
                expect(state.writes).toHaveLength(
                  finish === "valid_drop" ? 1 : 0,
                );
                await page.goto(url);
                await expect.poll(() => values(page)).toEqual(persisted);
                await expect(
                  form.getByLabel("Name", { exact: true }),
                ).toHaveValue(finish === "valid_drop" ? draft : "Order flow");
                expect(state.writes).toHaveLength(
                  finish === "valid_drop" ? 1 : 0,
                );
                matrix.push({
                  input,
                  rows: count === 1 ? "one" : count === 2 ? "two" : "five",
                  edge,
                  finish,
                  original,
                  initialProvisional,
                  initialListScroll,
                  initialProvisionalScroll,
                  finishingProvisionalScroll,
                  persisted,
                  writes: state.writes.length,
                  nativeScroll,
                  pointerPhases,
                  finishingInput: takeoverRestored ? pointerMode : input,
                  takeoverRestored,
                });
              },
            );
  } finally {
    await test.info().attach("priority-native-complete-matrix", {
      contentType: "application/json",
      body: JSON.stringify({
        expected:
          inputs.length *
          counts.reduce((sum, count) => sum + (count === 5 ? 28 : 21), 0),
        completed: matrix.length,
        matrix,
      }),
    });
  }
  cells.finish();
}

for (const activated of [false, true]) {
  test(`v0034.6 departure cancels ${activated ? "lifted" : "pending"} pointer draft without persistence`, async ({
    page,
  }) => {
    // The lifted case also qualifies native tab visibility.
    test.setTimeout(activated ? 180_000 : 30_000);
    await page.setViewportSize(designViewport(1440));
    const { writes } = await fixture(page);
    await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
    const grip = page.getByRole("button", {
      name: "Reorder first",
      exact: true,
    });
    await grip.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const start = (await grip.boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    if (activated) {
      await page.waitForTimeout(375);
      const target = (await page
        .locator("#flow-form [data-model-list] li")
        .nth(2)
        .boundingBox())!;
      expect(
        await page.evaluate(
          ({ x, y, alias }) =>
            document
              .elementFromPoint(x, y)
              ?.closest("li")
              ?.querySelector("select")?.value === alias,
          {
            x: target.x + target.width / 2,
            y: target.y + target.height / 2,
            alias: aliases[2],
          },
        ),
      ).toBe(true);
      await page.mouse.move(
        target.x + target.width / 2,
        target.y + target.height / 2,
      );
      await expect
        .poll(() => values(page))
        .toEqual([aliases[1], aliases[2], aliases[0]]);
    }
    await page.goto(`${proxy.baseUrl}?view=settings&section=parameters&team=1`);
    await page.mouse.up();
    await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
    await expect.poll(() => values(page)).toEqual(aliases.slice(0, 3));
    expect(writes).toEqual([]);
    if (activated) {
      const nativeTrace = test.info().outputPath("native-priority-browser.zip");
      const native = await startBrowserZoom({
        naturalVisibility: true,
        tracePath: nativeTrace,
      });
      const failures: unknown[] = [];
      let client:
        | Awaited<ReturnType<typeof native.context.newCDPSession>>
        | undefined;
      try {
        await test.info().attach("native-initial-tab-binding", {
          contentType: "application/json",
          body: JSON.stringify({
            pages: native.context.pages().map((p) => p.url()),
            tabs: await native.inspectOwnedTabs(),
          }),
        });
        const candidate = await native.context.newPage();
        await candidate.bringToFront();
        const state = await fixture(candidate);
        const navigation: Array<Record<string, unknown>> = [];
        candidate.on("request", (request) => {
          if (navigation.length < 100)
            navigation.push({
              kind: "request",
              method: request.method(),
              path: new URL(request.url()).pathname,
            });
        });
        candidate.on("response", (response) => {
          if (navigation.length < 100)
            navigation.push({
              kind: "response",
              status: response.status(),
              path: new URL(response.url()).pathname,
            });
        });
        try {
          await candidate.goto(
            `${proxy.baseUrl}?view=flows&team=1&id=${flowID}`,
            { timeout: 10_000, waitUntil: "domcontentloaded" },
          );
          await expect(candidate.locator("#flow-form")).toBeVisible({
            timeout: 10_000,
          });
        } catch (error) {
          await test.info().attach("native-navigation-diagnostic", {
            contentType: "application/json",
            body: JSON.stringify({ url: candidate.url(), navigation }),
          });
          throw error;
        }
        client = await native.context.newCDPSession(candidate);
        // Paired apparatus control: Playwright normally emulates page focus
        // and visibility. The Chrome tab operation itself is native in both trials.
        await client.send("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });
        const defaultTrial = await native.switchToBlankTab(candidate.url());
        expect(defaultTrial.fromActive).toBe(false);
        expect(defaultTrial.blankActive).toBe(true);
        const emulatedVisibility = await candidate.evaluate(
          () => document.visibilityState,
        );
        expect(emulatedVisibility).toBe("visible");
        expect(await defaultTrial.restore()).toBe(true);
        await client.send("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        await expect
          .poll(() => candidate.evaluate(() => document.visibilityState))
          .toBe("visible");
        await candidate.evaluate(() => {
          (window as any).__nativeVisibility = [];
          document.addEventListener("visibilitychange", (event) => {
            (window as any).__nativeVisibility.push({
              state: document.visibilityState,
              trusted: event.isTrusted,
            });
          });
        });
        const handle = candidate.getByRole("button", {
          name: "Reorder first",
          exact: true,
        });
        await handle.press("Space");
        await handle.press("ArrowDown");
        await handle.press("ArrowDown");
        await expect
          .poll(() => values(candidate))
          .toEqual([aliases[1], aliases[2], aliases[0]]);
        await expect(handle).toHaveAttribute("aria-pressed", "true");
        const actualTrial = await native.switchToBlankTab(candidate.url());
        try {
          expect(actualTrial.fromActive).toBe(false);
          expect(actualTrial.blankActive).toBe(true);
          await expect
            .poll(() => candidate.evaluate(() => document.visibilityState))
            .toBe("hidden");
          const events = await candidate.evaluate(
            () => (window as any).__nativeVisibility,
          );
          expect(events).toContainEqual({ state: "hidden", trusted: true });
          expect(
            await candidate.evaluate(() =>
              Boolean(Object.getOwnPropertyDescriptor(document, "hidden")),
            ),
          ).toBe(false);
          await expect
            .poll(() => values(candidate))
            .toEqual(aliases.slice(0, 3));
          await expect(handle).toHaveAttribute("aria-pressed", "false");
          expect(state.writes).toEqual([]);
          await test
            .info()
            .attach("native-browser-tab-visibility-qualification", {
              contentType: "application/json",
              body: JSON.stringify({
                image: proxy.webUIImageID,
                rowCount: 3,
                input: "keyboard",
                emulatedVisibility,
                actualVisibility: "hidden",
                actualTrial: {
                  fromActive: actualTrial.fromActive,
                  blankActive: actualTrial.blankActive,
                },
                events,
                draftRestored: true,
                writes: 0,
                matrixOneTwoFiveRows:
                  "not exercised by this capability qualification",
              }),
            });
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            expect(await actualTrial.restore()).toBe(true);
          } catch (error) {
            failures.push(error);
          }
        }
        await expect
          .poll(() => candidate.evaluate(() => document.visibilityState))
          .toBe("visible");
        await candidate.reload();
        await expect.poll(() => values(candidate)).toEqual(aliases.slice(0, 3));
        expect(state.writes).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await native.close();
        } catch (error) {
          failures.push(error);
        }
        if (existsSync(nativeTrace)) {
          try {
            await test.info().attach("native-priority-browser-trace", {
              path: nativeTrace,
              contentType: "application/zip",
            });
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Native tab visibility qualification failed",
        );
    }
  });
}

test("v0034.6 five-model edge scroll moves the page over the list and stops outside", async ({
  page,
}) => {
  // The approved editor is a page of section cards; the model list scrolls
  // with the page, so edge auto-scroll moves the page while the pointer is
  // over the list and stops once it leaves the list.
  await page.setViewportSize(designViewport(390));
  const { writes } = await fixture(page);
  await page.goto(`${proxy.baseUrl}?view=flows&team=1&id=${flowID}`);
  const form = page.locator("#flow-form"),
    list = form.locator("[data-model-list]");
  await form
    .getByRole("button", { name: "Add existing model", exact: true })
    .click();
  await form
    .getByRole("button", { name: "Add existing model", exact: true })
    .click();
  const original = await values(page),
    grip = form.getByRole("button", { name: "Reorder first", exact: true });
  const pageScroll = () =>
    page.evaluate(() => document.scrollingElement!.scrollTop);
  // Place the first grip near the bottom so the five-row list crosses the
  // actual viewport edge before the drag.
  await page.evaluate(() => {
    const first = document.querySelector("#flow-form [data-model-grip]")!;
    scrollBy(0, first.getBoundingClientRect().top - innerHeight + 180);
  });
  const start = (await grip.boundingBox())!,
    listBounds = (await list.boundingBox())!;
  const { height } = page.viewportSize()!;
  expect(listBounds.y + listBounds.height).toBeGreaterThan(height);
  const before = await pageScroll();
  const edge = height - 6;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  try {
    await page.waitForTimeout(375);
    await page.mouse.move(start.x + start.width / 2, edge);
    await expect.poll(pageScroll).toBeGreaterThan(before + 20);
    await page.mouse.move(1, edge);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const stopped = await pageScroll();
    await page.waitForTimeout(150);
    expect(await pageScroll()).toBe(stopped);
    await page.mouse.up();
    await expect.poll(() => values(page)).toEqual(original);
    // Cancelling outside the list restores the page position.
    await expect.poll(pageScroll).toBe(before);
    expect(writes).toEqual([]);
  } finally {
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
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
