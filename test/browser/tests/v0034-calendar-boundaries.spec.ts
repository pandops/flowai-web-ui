import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { captureDesignState, designViewport } from "../fixtures/design-capture";

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

const samples = [
  { period: "month", initial: "0001-02", previous: "0001-01" },
  { period: "week", initial: "0001-W02", previous: "0001-W01" },
];
test("v0034.15 month and week navigation preserve low-year keys and the supported lower bound", async ({
  page,
}) => {
  const queries: URL[] = [];
  let sample = samples[0];
  await page.route("**/ui/v1/operator/settings", (route) =>
    route.fulfill({
      json: { time_zone: "UTC" },
      headers: { etag: '"op-1"' },
    }),
  );
  await page.route("**/ui/v1/teams/1/dashboard?**", (route) => {
    const query = new URL(route.request().url());
    queries.push(query);
    // The approved Overview offers period navigation only beside a
    // calendar with runs, so each served period carries one run per day.
    const key = query.searchParams.get(sample.period) || "";
    const start = new Date(0);
    if (sample.period === "month") {
      start.setUTCFullYear(
        Number(key.slice(0, 4)),
        Number(key.slice(5)) - 1,
        1,
      );
    } else {
      start.setUTCFullYear(Number(key.slice(0, 4)), 0, 4);
      start.setUTCDate(
        start.getUTCDate() -
          ((start.getUTCDay() + 6) % 7) +
          (Number(key.slice(6)) - 1) * 7,
      );
    }
    const end = new Date(start.getTime());
    end.setUTCMonth(end.getUTCMonth() + 1);
    const days =
      sample.period === "month"
        ? Math.round((end.getTime() - start.getTime()) / 86400000)
        : 7;
    const buckets = Array.from({ length: days }, (_, index) => {
      const day = new Date(start.getTime() + index * 86400000);
      const bucketKey = `${String(day.getUTCFullYear()).padStart(4, "0")}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
      return {
        key: bucketKey,
        at: day.toISOString(),
        total: 1,
        counts: { queued: 1 },
        label: String(day.getUTCDate()),
        shortLabel: String(day.getUTCDate()),
        isFuture: false,
      };
    });
    return route.fulfill({
      json: {
        period: sample.period,
        time_zone: "UTC",
        counts: {
          queued: days,
          created: 0,
          running: 0,
          finished: 0,
          failed: 0,
        },
        buckets,
      },
    });
  });
  for (const next of samples)
    await test.step(`v0034.15 ${next.period} navigation preserves low-year keys and the supported lower bound`, async () => {
      sample = next;
      queries.length = 0;
      await page.goto(
        `${proxy.baseUrl}?view=dashboard&team=1&period=${sample.period}&${sample.period}=${sample.initial}`,
      );
      await expect
        .poll(() => queries.at(-1)?.searchParams.get(sample.period))
        .toBe(sample.initial);
      const previous = page.getByRole("button", {
        name: `Previous ${sample.period}`,
        exact: true,
      });
      await previous.click();
      await expect
        .poll(() => queries.at(-1)?.searchParams.get(sample.period))
        .toBe(sample.previous);
      expect(new URL(page.url()).searchParams.get(sample.period)).toBe(
        sample.previous,
      );
      await expect(previous).toBeDisabled();
      await page.reload();
      await expect(previous).toBeDisabled();
      expect(new URL(page.url()).searchParams.get(sample.period)).toBe(
        sample.previous,
      );
      await page
        .getByRole("button", { name: `Next ${sample.period}`, exact: true })
        .click();
      await expect
        .poll(() => queries.at(-1)?.searchParams.get(sample.period))
        .toBe(sample.initial);
      await page.goBack();
      await expect(previous).toBeDisabled();
      expect(new URL(page.url()).searchParams.get(sample.period)).toBe(
        sample.previous,
      );
    });
});
// Read actual numeric ink over each actual month fill. Canvas resolves the
// browser's computed CSS Color 4 mixes to opaque sRGB; the luminance formula
// is WCAG's relative-luminance definition, independent of the tier algorithm.
for (const theme of ["dark", "light"])
  test(`v0034.3 Month counts retain readable approved foregrounds on all four tiers ${theme}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript(
      (theme) => localStorage.setItem("flowai.theme", theme),
      theme,
    );
    await page.route("**/ui/v1/operator/settings", (route) =>
      route.fulfill({
        json: { time_zone: "UTC" },
        headers: { etag: '\"op-1\"' },
      }),
    );
    const totals = [0, 25, 50, 75, 100, 0, 100];
    await page.route("**/ui/v1/teams/1/dashboard?**", (route) =>
      route.fulfill({
        json: {
          period: "month",
          calendar_key: "2026-09",
          time_zone: "UTC",
          counts: {
            queued: Array.from(
              { length: 30 },
              (_, index) => totals[index % totals.length],
            ).reduce((sum, count) => sum + count, 0),
          },
          buckets: Array.from({ length: 30 }, (_, index) => ({
            key: `2026-09-${String(index + 1).padStart(2, "0")}`,
            at: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
            total: totals[index % totals.length],
            counts: { queued: totals[index % totals.length] },
            label: String(index + 1),
            shortLabel: String(index + 1),
            isFuture: false,
          })),
        },
      }),
    );
    for (const width of [390, 820, 1440])
      await test.step(`v0034.3 Month counts retain readable approved foregrounds on all four tiers ${theme} ${width}`, async () => {
        await page.setViewportSize(designViewport(width));
        await page.goto(
          `${proxy.baseUrl}?view=dashboard&team=1&period=month&month=2026-09`,
        );
        const days = page.locator(".month-day[data-dashboard-date]");
        await expect(days).toHaveCount(30);
        for (const tier of [0, 1, 2, 3]) {
          const day = page
            .locator(`.month-day[data-count-level="${tier}"]`)
            .first();
          await expect(day).toBeVisible();
          const paints = await day.evaluate((element) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d")!;
            const pixel = (color: string) => {
              if (!CSS.supports("color", color))
                throw new Error(`Unresolved chart paint: ${color}`);
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              const rgba = Array.from(context.getImageData(0, 0, 1, 1).data);
              if (rgba[3] !== 255)
                throw new Error("Chart contrast requires opaque paints");
              return rgba.slice(0, 3);
            };
            return {
              fill: pixel(
                getComputedStyle(element.querySelector("[data-count-fill]")!)
                  .backgroundColor,
              ),
              inks: [".day-count", ".month-day-label"].map((selector) =>
                pixel(getComputedStyle(element.querySelector(selector)!).color),
              ),
            };
          });
          const luminance = (rgb: number[]) =>
            rgb
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4;
              })
              .reduce(
                (sum, value, index) =>
                  sum + value * [0.2126, 0.7152, 0.0722][index],
                0,
              );
          for (const ink of paints.inks) {
            const a = luminance(ink),
              b = luminance(paints.fill);
            expect(
              (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
              JSON.stringify({ theme, tier, ...paints }),
            ).toBeGreaterThanOrEqual(4.5);
            // Exact accepted future semantic pairing, not the current CSS token.
            expect(ink).toEqual(
              theme === "light"
                ? tier === 3
                  ? [255, 255, 255]
                  : [23, 32, 46]
                : tier >= 2
                  ? [6, 16, 29]
                  : [248, 250, 252],
            );
          }
        }
        const layout = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          overflowing: [...document.querySelectorAll("body *")]
            .map((element) => ({
              tag: element.tagName,
              className: element.className,
              left: element.getBoundingClientRect().left,
              right: element.getBoundingClientRect().right,
            }))
            .filter(
              (element) => element.right > innerWidth || element.left < 0,
            ),
        }));
        expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(
          layout.width,
        );
        await captureDesignState(
          page,
          test.info(),
          proxy.webUIImageID,
          `month-tier-ink-${theme}-${width}`,
        );
      });
  });

test.afterEach(async ({ page }, info) => {
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    `final-${info.title}`,
  );
});
