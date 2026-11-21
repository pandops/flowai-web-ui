import { captureDesignState, designViewport } from "../fixtures/design-capture";
import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

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

for (const theme of ["dark", "light"])
  test(`v0034.15 Source poll summary and technical timestamps use the saved zone after focus refresh ${theme}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript(
      (theme) => localStorage.setItem("flowai.theme", theme),
      theme,
    );
    let zone = "America/New_York",
      preferenceReads = 0;
    await page.route("**/ui/v1/operator/settings", (route) => {
      preferenceReads++;
      return route.fulfill({
        json: { time_zone: zone },
        headers: {
          etag: zone === "America/New_York" ? '"op-1"' : '"op-2"',
        },
      });
    });
    const sourceID = 8013;
    const started = "2025-11-02T05:30:00Z",
      finished = "2025-11-02T06:30:00Z";
    const source = {
      source_id: sourceID,
      team_id: 1,
      name: "timezone-poller",
      mode: "poller",
      enabled: true,
      contract_version: "source.v1",
      implementation_version: "1",
      revision: 7,
      settings_status: "incomplete",
      health: "stale",
      description: "",
      filter_summary: "",
      // The approved Polling list shows one timestamp per row (Last seen
      // at, Last poll), so the two repeated-hour instants are carried by
      // the last observation and the finished poll.
      last_seen_at: started,
      polling: {
        polling_blocked_at: "2025-11-02T06:31:00Z",
        consecutive_failures: 5,
        next_poll_at: null,
      },
      last_poll: {
        poll_id: 7028,
        started_at: started,
        finished_at: finished,
        status: "failed",
        outcome: "failed",
        error_code: "callback_failed",
        returned_tasks: 0,
      },
      intake_counts: {
        published: 5,
        rejected: 0,
        accepted: 0,
        deduplicated: 0,
        no_target: 0,
        failed: 5,
      },
    };
    await page.route(`**/ui/v1/sources/${sourceID}`, (route) =>
      route.fulfill({ json: source, headers: { etag: '"rev-7"' } }),
    );
    await page.route(`**/ui/v1/sources/${sourceID}/settings`, (route) =>
      route.fulfill({
        json: {
          source_id: sourceID,
          mode: "poller",
          fields: [],
          settings_status: "incomplete",
          platform: {
            poll_url: "https://poller.example/tasks",
            poll_interval_minutes: 5,
          },
        },
        headers: { etag: '"rev-7"' },
      }),
    );
    await page.route("**/ui/v1/flows?**", (route) =>
      route.fulfill({ json: { items: [], next_cursor: null } }),
    );
    let writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() !== "GET" &&
        new URL(request.url()).pathname.startsWith("/ui/v1/")
      )
        writes.push(request.url());
    });
    for (const width of [390, 820, 1440])
      await test.step(`v0034.15 Source poll summary and technical timestamps use the saved zone after focus refresh ${theme} ${width}`, async () => {
        zone = "America/New_York";
        preferenceReads = 0;
        writes = [];
        await page.setViewportSize(designViewport(width));
        await page.goto(`${proxy.baseUrl}?view=source&team=1&id=${sourceID}`);
        const root = page.locator("#source-detail");
        await expect(
          root.locator(`time[datetime="${started}"]`).first(),
        ).toContainText(/01:30 -04:00/);
        await expect(
          root.locator(`time[datetime="${finished}"]`).first(),
        ).toContainText(/01:30 -05:00/);
        await expect(root).not.toContainText(started);
        await expect(root).not.toContainText(finished);
        const before = preferenceReads;
        zone = "Europe/Moscow";
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => preferenceReads).toBeGreaterThan(before);
        for (const node of await root
          .locator(`time[datetime="${started}"]`)
          .all())
          await expect(node).toContainText(/08:30 \+03:00/);
        for (const node of await root
          .locator(`time[datetime="${finished}"]`)
          .all())
          await expect(node).toContainText(/09:30 \+03:00/);
        expect(writes).toEqual([]);
        await captureDesignState(
          page,
          test.info(),
          proxy.webUIImageID,
          `poll-technical-saved-zone-${theme}-${width}`,
        );
      });
  });
