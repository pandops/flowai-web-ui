import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  TEAM_NAME,
  captureStreams,
  catalogRoutes,
  event,
  recordRequests,
  summary,
  taskRecord,
  v0048Proxy,
  MATRIX,
  usePresentation,
  expectNoHorizontalScroll,
} from "../fixtures/v0048-ui";

// web-ui: Web UI renders an actionable task dashboard (v0048).
// Behavior tests run at the supported desktop resolution (1440 x 900);
// the matrix tests below set each supported resolution themselves.
test.use({
  actionTimeout: 10_000,
  timezoneId: "UTC",
  viewport: { width: 1440, height: 900 },
});
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const STATES = [
  "queued",
  "created",
  "pending",
  "running",
  "finished",
  "failed",
  "cancelled",
];
const zero = () => Object.fromEntries(STATES.map((state) => [state, 0]));
const day = (date: Date) => date.toISOString().slice(0, 10);
const TODAY = "2026-08-19";

/** journal's dashboard reply over a mutable per-day queued count. */
async function dashboardRoutes(page: Page, queuedByDay: Map<string, number>) {
  await page.route(`**/ui/v1/teams/${TEAM}/dashboard?**`, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const period = query.get("period") === "month" ? "month" : "week";
    const key =
      query.get(period) || (period === "week" ? "2026-W34" : "2026-08");
    let days: Date[];
    if (period === "week") {
      const week = Number(key.slice(6));
      const monday = new Date(Date.UTC(2026, 7, 17 + (week - 34) * 7));
      days = [...Array(7)].map(
        (_, index) => new Date(monday.getTime() + index * 86_400_000),
      );
    } else {
      const [year, month] = key.split("-").map(Number);
      const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
      days = [...Array(length)].map(
        (_, index) => new Date(Date.UTC(year, month - 1, index + 1)),
      );
    }
    const counts = zero();
    const buckets = days.map((date) => {
      const queued = queuedByDay.get(day(date)) ?? 0;
      counts.queued += queued;
      return {
        at: date.toISOString(),
        key: day(date),
        label: day(date),
        shortLabel: String(date.getUTCDate()),
        total: queued,
        counts: { ...zero(), queued },
        isFuture: day(date) > TODAY,
      };
    });
    return route.fulfill({
      json: { period, calendar_key: key, time_zone: "UTC", counts, buckets },
    });
  });
}

const bucket = (page: Page, date: string) =>
  page.locator(`[data-dashboard-date="${date}"]`);
// Each day column's accessible name ends "<date>: <N> runs; open Tasks".
const runs = (label: string | null) =>
  Number(label?.match(/: (\d+) runs?; open Tasks$/)?.[1] ?? NaN);
/** The day's count read from its accessible name. */
const dayCount = async (page: Page, date: string) =>
  runs(await bucket(page, date).getAttribute("aria-label"));
/** The period total the dashboard shows: its "N runs" summary. */
const periodTotal = async (page: Page) =>
  Number(
    (await page.locator("[data-calendar] > p").first().innerText()).match(
      /(\d+) runs?\b/,
    )?.[1] ?? NaN,
  );

test("v0048 dashboard counts new tasks once and opens task history by day · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00Z`));
  const queuedByDay = new Map([
    [TODAY, 2],
    ["2026-08-15", 1],
    ["2026-07-03", 4],
  ]);
  const tasks = [
    taskRecord(1039, {
      current_state: "queued",
      executor_id: null,
      ingested_at: `${TODAY}T08:00:00.000Z`,
    }),
  ];
  await catalogRoutes(page);
  await dashboardRoutes(page, queuedByDay);
  await page.route(
    new RegExp(`/ui/v1/teams/${TEAM}/tasks(?:\\?.*)?$`),
    (route) =>
      route.fulfill({ json: { items: tasks.map(summary), next_cursor: null } }),
  );
  const stream = await captureStreams(page);
  const requests = recordRequests(page);
  await page.goto(`${proxy.baseUrl}/?view=dashboard&team=${TEAM}`);
  await expect(bucket(page, TODAY)).toContainText("2");
  await expect.poll(() => dayCount(page, TODAY)).toBe(2);

  await test.step("New task updates the open dashboard", async () => {
    // Week 34 holds only today's two queued tasks.
    const totalBefore = await periodTotal(page);
    expect(totalBefore).toBe(2);
    // journal commits task 1040's first queued event.
    queuedByDay.set(TODAY, 3);
    const created = taskRecord(1040, {
      current_state: "queued",
      executor_id: null,
      ingested_at: `${TODAY}T10:00:00.000Z`,
    });
    tasks.unshift(created);
    const queued = event("queued", 0, { task_id: 1040, attempt: 1 });
    await stream.send(queued, "task_committed");
    // The period total and today's queued count rise by exactly one.
    await expect.poll(() => dayCount(page, TODAY)).toBe(3);
    await expect.poll(() => periodTotal(page)).toBe(totalBefore + 1);
    await expect(
      page.getByRole("link", { name: `${TEAM_NAME}-1040`, exact: true }),
    ).toBeVisible();
    // The replayed frame is not counted again.
    await stream.send(queued, "task_committed");
    await page.waitForTimeout(500);
    expect(await dayCount(page, TODAY)).toBe(3);
    expect(await periodTotal(page)).toBe(totalBefore + 1);
    await expect(
      page.getByRole("link", { name: `${TEAM_NAME}-1040`, exact: true }),
    ).toHaveCount(1);
    // No lifecycle-status statistic cards.
    await expect(page.locator("main")).not.toContainText(/\bQueued\s+\d+\b/);
  });

  await test.step("Operator opens an earlier ISO week", async () => {
    await page
      .getByRole("button", { name: "Previous week", exact: true })
      .click();
    await expect(page).toHaveURL(/[?&]week=2026-W33(&|$)/);
    await expect(page.locator("main")).toContainText("Week 33, 2026");
    const dates = await page
      .locator("[data-dashboard-date]")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-dashboard-date")),
      );
    expect(dates).toEqual(
      [10, 11, 12, 13, 14, 15, 16].map((date) => `2026-08-${date}`),
    );
    await page.goBack();
    await expect(page.locator("main")).toContainText("Week 34, 2026");
  });

  await test.step("Operator opens an earlier calendar month", async () => {
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await page
      .getByRole("button", { name: "Previous month", exact: true })
      .click();
    await expect(page).toHaveURL(/[?&]month=2026-07(&|$)/);
    await expect(page.locator("[data-dashboard-date]")).toHaveCount(31);
    await expect(bucket(page, "2026-07-03")).toContainText("4");
    await page.goBack();
    await expect(page).not.toHaveURL(/month=2026-07/);
    // The current month is shown again, with today's count.
    await expect(page.locator("main")).toContainText("August 2026");
    await expect(page.locator("[data-dashboard-date]")).toHaveCount(31);
    await expect(bucket(page, "2026-07-03")).toHaveCount(0);
    await expect.poll(() => dayCount(page, TODAY)).toBe(3);
  });

  await test.step("Operator opens one dashboard day", async () => {
    await page.goto(
      `${proxy.baseUrl}/?view=dashboard&team=${TEAM}&period=week&week=2026-W33`,
    );
    requests.length = 0;
    await bucket(page, "2026-08-15").click();
    await expect(page).toHaveURL(/[?&]view=history(&|$)/);
    await expect(page).toHaveURL(/[?&]date=2026-08-15(&|$)/);
    await expect(page.getByLabel("Date", { exact: true })).toHaveValue(
      "2026-08-15",
    );
    // The history read (not a recent-tasks refresh) carries the date.
    await expect
      .poll(() =>
        requests
          .filter((request) => request.path === `/ui/v1/teams/${TEAM}/tasks`)
          .map((request) => request.search.get("date")),
      )
      .toContain("2026-08-15");
  });
});

test("v0048 dashboard at every supported resolution and theme · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00Z`));
  await catalogRoutes(page);
  await dashboardRoutes(page, new Map([[TODAY, 2]]));
  await page.route(
    new RegExp(`/ui/v1/teams/${TEAM}/tasks(?:\\?.*)?$`),
    (route) =>
      route.fulfill({
        json: {
          items: [
            summary(
              taskRecord(1039, { current_state: "queued", executor_id: null }),
            ),
          ],
          next_cursor: null,
        },
      }),
  );
  for (const { theme, width, height } of MATRIX)
    await test.step(`${theme} ${width}`, async () => {
      await usePresentation(page, theme, { width, height });
      await page.emulateMedia({ colorScheme: theme });
      const session = await page.context().newCDPSession(page);
      const hasTouch = width !== 1440;
      try {
        await session.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: width === 390 ? 3 : width === 820 ? 2 : 1,
          mobile: hasTouch,
        });
        await session.send("Emulation.setTouchEmulationEnabled", { enabled: hasTouch });
        await page.goto(`${proxy.baseUrl}/?view=dashboard&team=${TEAM}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(bucket(page, TODAY)).toBeVisible();
        await expectNoHorizontalScroll(page);
        const observed = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          deviceScaleFactor: devicePixelRatio,
          hasTouch: navigator.maxTouchPoints > 0,
          theme: document.documentElement.dataset.theme,
          darkMedia: matchMedia("(prefers-color-scheme: dark)").matches,
        }));
        await test.info().attach("supported-resolution", {
          body: JSON.stringify(observed),
          contentType: "application/json",
        });
      } finally {
        await session.detach();
      }
    });
});
