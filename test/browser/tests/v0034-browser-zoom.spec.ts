import path from "node:path";
import { cancelFlow, flowEditor, saveFlow } from "../fixtures/flow-editor";
import { test as base, expect } from "../fixtures/owned-test";
import { startBrowserZoom } from "../fixtures/browser_zoom";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture, flowID } from "../fixtures/v0034-flow";
import { parameterFixture } from "../fixtures/v0034-parameters";

const test = base.extend<{
  zoom: Awaited<ReturnType<typeof startBrowserZoom>>;
}>({
  zoom: async ({}, use) => {
    const zoom = await startBrowserZoom();
    try {
      // Playwright's configured trace already covers this persistent context.
      await use(zoom);
    } finally {
      await zoom.close();
    }
  },
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

// One native zoom browser per theme; each surface gets its own page.
for (const theme of ["dark", "light"])
  test(`v0034.12 actual200percent browser zoom preserves parameters, flow editor and model form controls and full values ${theme}`, async ({
    zoom,
  }, info) => {
    test.setTimeout(150_000);
    for (const surface of ["parameters", "flow editor", "model form"] as const)
      await test.step(`v0034.12 actual200percent browser zoom preserves ${surface} controls and full values ${theme}`, async () => {
        // The first surface keeps the launch tab; each later one opens its
        // own tab, then closes the previous one, so setZoom finds one tab.
        const previous = zoom.context.pages();
        const page =
          surface === "parameters" && previous[0]
            ? previous[0]
            : await zoom.context.newPage();
        for (const other of previous) if (other !== page) await other.close();
        const writes: string[] = [];
        page.on("request", (request) => {
          if (
            request.method() !== "GET" &&
            new URL(request.url()).pathname.startsWith("/ui/v1/")
          )
            writes.push(
              `${request.method()} ${new URL(request.url()).pathname}`,
            );
        });
        await page.addInitScript(
          (theme) => localStorage.setItem("flowai.theme", theme),
          theme,
        );
        if (surface === "parameters") {
          const fixture = await parameterFixture(page);
          fixture.definitions[1].env.SHARED = "long-readable-value-".repeat(16);
        } else await flowFixture(page);
        const query =
          surface === "parameters"
            ? "view=settings&section=parameters"
            : surface === "flow editor"
              ? `view=flow&id=${flowID}`
              : "view=settings&section=models";
        await page.goto(`${proxy.baseUrl}?${query}&team=1`);
        await expect(page.locator("h1")).toBeVisible();
        const before = await page.evaluate(() => ({
          width: innerWidth,
          outer: outerWidth,
          dpr: devicePixelRatio,
        }));
        expect(await zoom.setZoom(page.url(), 2)).toBe(2);
        await expect
          .poll(() => page.evaluate(() => innerWidth))
          .toBeLessThanOrEqual(Math.ceil(before.width / 2) + 1);
        const after = await page.evaluate(() => ({
          width: innerWidth,
          outer: outerWidth,
          dpr: devicePixelRatio,
          pinch: visualViewport?.scale,
          htmlZoom: getComputedStyle(document.documentElement).zoom,
          bodyZoom: getComputedStyle(document.body).zoom,
        }));
        expect(after.width).toBeGreaterThanOrEqual(
          Math.floor(before.width / 2) - 1,
        );
        expect(after.outer).toBe(before.outer);
        expect(after.dpr / before.dpr).toBeCloseTo(2, 2);
        expect(after.pinch).toBe(1);
        expect(after.htmlZoom).toBe("1");
        expect(after.bodyZoom).toBe("1");
        if (surface === "parameters") {
          await expect(
            page
              .getByText("long-readable-value-".repeat(16), { exact: true })
              .filter({ visible: true }),
          ).toBeVisible();
          const menu = page
            .getByRole("button", { name: "Actions for SHARED", exact: true })
            // The zoomed width re-renders the table as cards; take the
            // trigger of whichever representation is visible.
            .filter({ visible: true })
            .first();
          await expect(menu).toBeVisible();
          await menu.click();
          await expect(
            page
              .getByRole("menu", { name: "Actions for SHARED", exact: true })
              .getByRole("menuitem", { name: "Edit variable", exact: true }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
        } else if (surface === "flow editor") {
          await page
            .getByRole("link", { name: "Edit flow", exact: true })
            .click();
          const dialog = flowEditor(page);
          await expect(saveFlow(dialog)).toBeVisible();
          await expect(cancelFlow(dialog)).toBeVisible();
          await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
            "Order flow",
          );
        } else {
          await page
            .getByRole("button", { name: "Create model", exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: "Create model",
            exact: true,
          });
          await expect(
            dialog.getByRole("button", { name: "Save model", exact: true }),
          ).toBeVisible();
          await expect(
            dialog.getByRole("button", { name: "Cancel", exact: true }),
          ).toBeVisible();
          await expect(
            dialog.getByLabel("Input price (USD per 1M tokens)", {
              exact: true,
            }),
          ).toBeVisible();
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(writes).toEqual([]);
        await info.attach("native-browser-zoom", {
          contentType: "application/json",
          body: JSON.stringify({
            image_id: proxy.webUIImageID,
            route: page.url(),
            zoom_factor: 2,
            native_api: "chrome.tabs.setZoom/getZoom",
            before,
            after,
            surface,
            theme,
          }),
        });
        // Full-page clipping in Chromium uses layout CSS pixels despite native
        // zoom. Capture the actual browser viewport without a clip/resize instead.
        const cdp = await zoom.context.newCDPSession(page);
        try {
          const captured = await cdp.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          });
          const png = Buffer.from(captured.data, "base64");
          expect(png.readUInt32BE(16)).toBe(before.width * before.dpr);
          await info.attach(`browser200-${surface}-${theme}-viewport`, {
            contentType: "image/png",
            body: png,
          });
        } finally {
          await cdp.detach();
        }
        // Chrome zoom is per origin: reset it so the next surface starts at
        // 100% (its own dpr check fails if it does not).
        expect(await zoom.setZoom(page.url(), 1)).toBe(1);
      });
  });
