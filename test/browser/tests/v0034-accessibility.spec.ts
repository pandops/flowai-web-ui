import { captureDesignState, designViewport } from "../fixtures/design-capture";
import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture } from "../fixtures/v0034-flow";
import { contrast } from "../fixtures/contrast";

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

// Contrast runs first, so forced colors never affects its measurements.
for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.12 contrast and forced-colors focus ${theme} ${width}`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      const { writes } = await flowFixture(page);
      await test.step(`v0034.12 common text and form boundaries retain measured contrast ${theme} ${width}`, async () => {
        await page.goto(`${proxy.baseUrl}?view=settings&section=models&team=1`);
        const create = page.getByRole("button", {
          name: "Create model",
          exact: true,
        });
        await expect(create).toBeVisible();
        const modelLink = page
          .locator("#models-results")
          .getByRole("link", { name: "first", exact: true });
        await expect(modelLink).toBeVisible();
        for (const locator of [
          page.locator(".team label"),
          page.locator("#current-models-heading"),
          modelLink,
        ]) {
          const measured = await contrast(locator);
          const large =
            measured.fontSize >= 24 ||
            (measured.fontSize >= 56 / 3 && measured.fontWeight >= 700);
          expect(
            measured.ratio,
            JSON.stringify(measured),
          ).toBeGreaterThanOrEqual(large ? 3 : 4.5);
        }
        const icon = await contrast(create.locator("svg"));
        expect(icon.ratio, JSON.stringify(icon)).toBeGreaterThanOrEqual(3);
        for (let index = 0; index < 60; index++) {
          await page.keyboard.press("Tab");
          if (
            await create.evaluate(
              (element) => element === document.activeElement,
            )
          )
            break;
        }
        await expect(create).toBeFocused();
        const focus = await create.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            visible: element.matches(":focus-visible"),
            style: style.outlineStyle,
            width: parseFloat(style.outlineWidth),
            offset: parseFloat(style.outlineOffset),
          };
        });
        expect(focus).toEqual({
          visible: true,
          style: "solid",
          width: 2,
          offset: 2,
        });
        await create.click();
        const dialog = page.getByRole("dialog", {
          name: "Create model",
          exact: true,
        });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel("Name", { exact: true }).fill("contrast-model");
        await dialog
          .getByLabel("Provider model", { exact: true })
          .fill("fixture-model");
        for (const input of await dialog
          .locator("input:not([type=checkbox]),select,textarea")
          .all()) {
          if (!(await input.isVisible()) || !(await input.isEnabled()))
            continue;
          const text = await contrast(input),
            border = await contrast(input, "borderTopColor");
          expect(text.ratio, JSON.stringify(text)).toBeGreaterThanOrEqual(4.5);
          expect(border.borderWidth).toBeGreaterThanOrEqual(1);
          expect(border.borderStyle).not.toBe("none");
          expect(border.ratio, JSON.stringify(border)).toBeGreaterThanOrEqual(
            3,
          );
        }
        await captureDesignState(
          page,
          test.info(),
          proxy.webUIImageID,
          `form-contrast-${theme}-${width}`,
        );
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect(create).toBeFocused();
        expect(writes).toEqual([]);
      });
      await test.step(`v0034.12 forced colors retain keyboard focus through a themed creation dialog ${theme} ${width}`, async () => {
        await page.emulateMedia({
          forcedColors: "active",
          reducedMotion: "reduce",
        });
        // Same page, routes and theme seed as the contrast step; the reload
        // gives a fresh document with focus at its start.
        const errors: string[] = [],
          external: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (
            ["http:", "https:"].includes(url.protocol) &&
            url.origin !== new URL(proxy.baseUrl).origin
          )
            external.push(url.origin);
        });
        await page.reload();
        const create = page.getByRole("button", {
          name: "Create model",
          exact: true,
        });
        await expect(create).toBeVisible();
        let reached = false;
        for (let count = 0; count < 60; count++) {
          await page.keyboard.press("Tab");
          if (
            await create.evaluate(
              (element) => element === document.activeElement,
            )
          ) {
            reached = true;
            break;
          }
        }
        expect(reached).toBe(true);
        const focus = await create.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            visible: element.matches(":focus-visible"),
            outline: style.outlineStyle,
            width: parseFloat(style.outlineWidth),
            box: element.getBoundingClientRect().toJSON(),
            forced: matchMedia("(forced-colors: active)").matches,
            reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          };
        });
        expect(focus.forced).toBe(true);
        expect(focus.reduced).toBe(true);
        expect(focus.visible).toBe(true);
        // Forced colors suppresses box shadows. The focus indicator must survive.
        expect(focus.outline).not.toBe("none");
        expect(focus.width).toBeGreaterThanOrEqual(2);
        expect(focus.box.width).toBeGreaterThanOrEqual(44);
        expect(focus.box.height).toBeGreaterThanOrEqual(44);
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", {
          name: "Create model",
          exact: true,
        });
        await expect(dialog).toBeVisible();
        for (let count = 0; count < 16; count++) {
          await page.keyboard.press("Tab");
          expect(
            await dialog.evaluate((element) =>
              element.contains(document.activeElement),
            ),
          ).toBe(true);
        }
        const themeControl = dialog.getByRole("button", {
          name: /^Switch to (dark|light) theme$/,
        });
        await themeControl.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(
          dialog.getByRole("button", { name: "Save model", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(themeControl).toBeFocused();
        await captureDesignState(
          page,
          test.info(),
          proxy.webUIImageID,
          `forced-colors-dialog-${theme}-${width}`,
        );
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect(create).toBeFocused();
        expect(writes).toEqual([]);
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      });
    });
