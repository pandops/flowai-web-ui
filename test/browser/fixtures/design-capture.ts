import { expect, type Page, type TestInfo } from "@playwright/test";
import { RESOLUTIONS } from "./v0048-ui";

export function designViewport(width: number) {
  const resolution = RESOLUTIONS.find((entry) => entry.width === width);
  if (!resolution) throw new Error(`Unsupported Web UI width ${width}`);
  return { width, height: resolution.height };
}

// Runtime screenshots come from the built Web UI. Tests never compare it with
// the design mockups (AGENTS.md, Test categories): the implementing agent does
// that once during implementation. Mask write-only and one-time fields.
export async function captureDesignState(
  page: Page,
  info: TestInfo,
  imageID: string | undefined,
  state: string,
) {
  if (page.isClosed()) return;
  // A capture may take screenshots, so the test budget grows per capture.
  if (info.timeout > 0) info.setTimeout(info.timeout + 5_000);
  if (!imageID)
    throw new Error(
      "A design capture requires the actual built Web UI image identity",
    );
  const name = state.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 110);
  const context = await page.evaluate(() => ({
    route: location.pathname + location.search,
    theme: document.documentElement.dataset.theme,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
    openDialogs: [...document.querySelectorAll("dialog[open]")].map(
      (dialog) => dialog.id,
    ),
    media: {
      forcedColors: matchMedia("(forced-colors: active)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
  }));
  // Screenshots are evidence, not the verdict, and cost most of a capture's
  // CPU: like traces they are kept for a failing capture or test only.
  const screenshots = async () => {
    const mask = [page.locator('input[type="password"],[data-source-key]')];
    // Keep the actual viewport too when scroll or a dialog affects visibility.
    // Do not scroll the page: scroll/focus/menu state is part of the evidence.
    if (context.scroll.x || context.scroll.y || context.openDialogs.length) {
      const viewport = info.outputPath(`${name}-viewport.png`);
      await page.screenshot({
        path: viewport,
        fullPage: false,
        animations: "disabled",
        mask,
      });
      await info.attach(`${state}-viewport`, {
        path: viewport,
        contentType: "image/png",
      });
    }
    const target = info.outputPath(`${name}.png`);
    await page.screenshot({
      path: target,
      fullPage: true,
      animations: "disabled",
      mask,
    });
    await info.attach(state, { path: target, contentType: "image/png" });
  };
  await info.attach(`${state}-context`, {
    body: JSON.stringify({
      imageID,
      kind: "built_web_ui_with_presentation_fixture",
      ...context,
    }),
    contentType: "application/json",
  });
  // Shared typography is specified by the versioned future exports, rather
  // than inferred from the implementation or from screenshot availability.
  const discrepancies = await page.evaluate(() => {
    if (
      !["dark", "light"].includes(document.documentElement.dataset.theme || "")
    )
      return []; // An external authentication document is not the Web UI.
    const differences: string[] = [];
    const check = (selector: string, property: string, expected: string) => {
      for (const element of document.querySelectorAll(selector)) {
        if (!element.getClientRects().length) continue;
        const actual = getComputedStyle(element).getPropertyValue(property);
        if (actual !== expected)
          differences.push(
            `${selector} ${property}: expected ${expected}, got ${actual}`,
          );
      }
    };
    check("body", "font-size", "14px");
    check("body", "line-height", "21px");
    check("body", "font-variant-numeric", "tabular-nums");
    check("h1", "line-height", "38.4px");
    check("h1", "letter-spacing", "-0.64px");
    check("h2", "letter-spacing", "-0.2px");
    check("th", "font-size", "11px");
    check("th", "font-weight", "600");
    check("th", "letter-spacing", "0.88px");
    for (const header of document.querySelectorAll("th"))
      if (
        header.getClientRects().length &&
        !getComputedStyle(header).fontFamily.includes("ui-monospace")
      )
        differences.push(
          "th font-family: expected the approved monospace stack",
        );
    return [...new Set(differences)];
  });
  await info.attach(`${state}-typography`, {
    body: JSON.stringify({
      oracle:
        "v0034 approved shared typography (the dashboard mockup's values)",
      discrepancies,
    }),
    contentType: "application/json",
  });
  // Every surface is self-contained: fonts, icons and scripts come only from
  // the Web UI origin (no external request on any captured state).
  const external = await page.evaluate(() =>
    [
      ...performance.getEntriesByType("navigation"),
      ...performance.getEntriesByType("resource"),
    ]
      .map((entry) => entry.name)
      .filter(
        (url) =>
          !url.startsWith(location.origin) && !/^(data|blob|about):/.test(url),
      ),
  );
  expect.soft(external, `${state} loaded external resources`).toEqual([]);
  // A full default buffer (250 entries) would hide later requests.
  expect
    .soft(
      await page.evaluate(
        () => performance.getEntriesByType("resource").length !== 250,
      ),
      `${state}: Resource Timing buffer full; raise it before capture`,
    )
    .toBe(true);
  if (
    discrepancies.length ||
    external.length ||
    info.errors.length ||
    (info.status !== undefined && info.status !== info.expectedStatus)
  )
    await screenshots();
  // Soft failures keep the test running so every later cell of the same
  // family is still captured and counted; the test still fails.
  expect
    .soft(
      discrepancies,
      `Approved shared typography differs: ${discrepancies.join("; ")}`,
    )
    .toEqual([]);
}
