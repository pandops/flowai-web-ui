import { captureDesignState, designViewport } from "../fixtures/design-capture";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture, flowID } from "../fixtures/v0034-flow";

// Fail missing-control actions before the test deadline, leaving teardown time.
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

const sourceID = 8029;
const entries = [
  {
    resource_type: "source",
    resource_id: sourceID,
    action: "source.settings.update",
  },
  { resource_type: "flow", resource_id: flowID, action: "flow.update" },
  {
    resource_type: "task_control_request",
    resource_id: 8031,
    action: "task.control.cancel",
  },
].map((entry, index) => ({
  // Approved audit.html shows the recorded action as a readable phrase.
  label: ["Source settings updated", "Flow updated", "Task control cancelled"][
    index
  ],
  ...entry,
  audit_id: 9000 + index + 1,
  team_id: 1,
  actor_id: 7030,
  actor_type: "operator",
  request_id: `safe-request-${index}`,
  outcome:
    entry.resource_type === "task_control_request" ? "accepted" : "succeeded",
  occurred_at: `2026-10-18T00:00:0${3 - index}Z`,
}));

// v0034.12 Audit compatibility route preserves canonical references and safe event inspection
async function auditCompatibility(page: Page, theme: string, width: number) {
  await page.setViewportSize(designViewport(width));
  await page.addInitScript(
    (theme) => localStorage.setItem("flowai.theme", theme),
    theme,
  );
  const { writes } = await flowFixture(page);
  await page.route("**/ui/v1/operator/settings", (route) =>
    route.fulfill({
      json: { time_zone: "Europe/Moscow" },
      headers: { etag: '"op-1"' },
    }),
  );
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            source_id: sourceID,
            name: "Audit source",
            mode: "webhook",
            enabled: true,
            revision: 1,
            implementation_version: "fixture",
            contract_version: "source.v1",
            settings_status: "complete",
            health: "never_seen",
          },
        ],
        next_cursor: null,
      },
    }),
  );
  const reads: string[] = [];
  await page.route("**/ui/v1/teams/1/audit?**", (route) => {
    reads.push(route.request().url());
    return route.fulfill({ json: { items: entries, next_cursor: null } });
  });
  await page.goto(`${proxy.baseUrl}?view=audit&team=1`);
  // Audit remains a compatibility destination, not a sixth primary item.
  await expect(
    page.locator('nav[aria-label="Main navigation"] a[data-view="audit"]'),
  ).toHaveCount(0);
  await expect(page.locator("[data-current-page]")).toHaveText("Audit");
  const results = page.locator("#audit-results");
  await expect(results.locator("thead th")).toHaveText([
    "Time",
    "Action",
    "Actor",
    "Resource",
    "Outcome",
  ]);
  const visibleRecords = results.locator("tbody tr:visible,article:visible");
  for (const entry of entries) {
    const instant = visibleRecords.locator(
      `time[datetime="${entry.occurred_at}"]`,
    );
    await expect(instant).toHaveCount(1);
    // Approved compact row time: "18 Oct, 03:00" in the operator zone.
    await expect(instant).toHaveText("18 Oct, 03:00");
  }
  for (const [view, id] of [
    ["source", sourceID],
    ["flow", flowID],
  ]) {
    const link = results.locator(
      `a[href="?view=${view}&team=1&id=${id}"]:visible`,
    );
    await expect(link).toHaveCount(1);
    await expect(link).toBeVisible();
  }
  // A control request has no canonical resource-view route. Do not guess a task ID.
  await expect(
    results.locator(`a[href*="${entries[2].resource_id}"]`),
  ).toHaveCount(0);
  await expect(
    results.getByText(entries[0].request_id, { exact: true }),
  ).toHaveCount(0);
  await expect(
    results
      .locator("tbody tr:visible,article:visible")
      .first()
      .getByText(String(entries[0].actor_id), { exact: true }),
  ).toBeVisible();
  const inspect = results.getByRole("button", {
    name: entries[0].label,
    exact: true,
  });
  await expect(inspect).toHaveCount(1);
  await inspect.click();
  const dialog = page.getByRole("dialog", {
    name: "Audit event detail",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator(`time[datetime="${entries[0].occurred_at}"]`),
  ).toHaveText("18 Oct 2026, 03:00 +03:00");
  for (const value of [
    entries[0].request_id,
    entries[0].actor_id,
    entries[0].label,
  ])
    await expect(
      dialog.getByText(String(value), { exact: true }),
    ).toBeVisible();
  await expect(
    dialog.locator(`a[href="?view=source&team=1&id=${sourceID}"]`),
  ).toHaveCount(1);
  // The accepted projection contains no settings values or credential detail.
  await expect(
    dialog.getByText(/safe details|credential material|api key/i),
  ).toHaveCount(0);
  await captureDesignState(
    page,
    test.info(),
    proxy.webUIImageID,
    `audit.html-detail-${theme}-${width}`,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(inspect).toBeFocused();
  // Capture resting commands, not the hover left by the inspection click.
  await page.mouse.move(0, 0);
  expect(writes).toEqual([]);
  expect(reads).toHaveLength(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await captureDesignState(
    page,
    test.info(),
    proxy.webUIImageID,
    `audit.html-default-${theme}-${width}`,
  );
}

// v0034.12 Audit inspection wraps complete long actor and request identifiers
async function auditLongIdentities(page: Page, theme: string) {
  await page.setViewportSize(designViewport(390));
  await page.addInitScript(
    (theme) => localStorage.setItem("flowai.theme", theme),
    theme,
  );
  const { writes } = await flowFixture(page);
  const actor = `operator-${"a".repeat(160)}`,
    request = `request-${"r".repeat(120)}`;
  const entry = { ...entries[0], actor_id: actor, request_id: request };
  await page.route("**/ui/v1/teams/1/audit?**", (route) =>
    route.fulfill({ json: { items: [entry], next_cursor: null } }),
  );
  await page.goto(`${proxy.baseUrl}?view=audit&team=1`);
  const inspect = page
    .locator("#audit-results")
    .getByRole("button", { name: entry.label, exact: true });
  await expect(inspect).toHaveCount(1);
  await inspect.click();
  const dialog = page.getByRole("dialog", {
    name: "Audit event detail",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  for (const value of [actor, request]) {
    const field = dialog.getByText(String(value), { exact: true });
    await expect(field).toBeVisible();
    const geometry = await field.evaluate((element) => {
      const style = getComputedStyle(element),
        range = document.createRange();
      range.selectNodeContents(element);
      return {
        text: element.textContent,
        width: element.clientWidth,
        scroll: element.scrollWidth,
        lines: range.getClientRects().length,
        overflow: style.overflowX,
        ellipsis: style.textOverflow,
        clamp: style.webkitLineClamp,
      };
    });
    expect(geometry.text).toBe(value);
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.lines, JSON.stringify(geometry)).toBeGreaterThan(1);
    expect(geometry.overflow).not.toMatch(/hidden|clip/);
    expect(geometry.ellipsis).not.toBe("ellipsis");
    expect(geometry.clamp).toBe("none");
  }
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await captureDesignState(
    page,
    test.info(),
    proxy.webUIImageID,
    `audit-long-identities-${theme}`,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(inspect).toBeFocused();
  expect(writes).toEqual([]);
}

async function pagedAudit(
  page: import("@playwright/test").Page,
  holdInitial = false,
) {
  const { writes } = await flowFixture(page);
  const records = Array.from({ length: 25 }, (_, index) => ({
    ...entries[index % entries.length],
    audit_id: index + 1,
    actor_id: `actor-${index}@fixture.test`,
    request_id: `request-${index}`,
    occurred_at: new Date(
      Date.parse("2026-10-18T00:00:00Z") - index * 1000,
    ).toISOString(),
  }));
  const reads: URL[] = [];
  const cursors = new Map<
    string,
    { offset: number; search: string; limit: number }
  >();
  let outage = false,
    held = holdInitial,
    captured = false,
    release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ui/v1/teams/1/audit?**", async (route) => {
    const url = new URL(route.request().url());
    reads.push(url);
    if (held) {
      held = false;
      captured = true;
      await wait;
    }
    if (outage)
      return route.fulfill({ status: 503, json: { code: "unavailable" } });
    const search = url.searchParams.get("search") || "",
      limit = Number(url.searchParams.get("limit") || 10);
    const cursor = url.searchParams.get("cursor"),
      previous = cursor ? cursors.get(cursor) : undefined;
    if (
      cursor &&
      (!previous || previous.search !== search || previous.limit !== limit)
    )
      return route.fulfill({ status: 400, json: { code: "invalid_cursor" } });
    const matching = records.filter((entry) =>
      [entry.action, entry.actor_id, entry.resource_id].some((value) =>
        String(value).toLowerCase().includes(search.toLowerCase()),
      ),
    );
    const offset = previous?.offset || 0,
      next =
        offset + limit < matching.length
          ? `audit-page-${cursors.size + 1}`
          : null;
    if (next) cursors.set(next, { offset: offset + limit, search, limit });
    return route.fulfill({
      json: {
        items: matching.slice(offset, offset + limit),
        next_cursor: next,
      },
    });
  });
  return {
    writes,
    records,
    reads,
    release,
    captured: () => captured,
    setOutage: (value: boolean) => {
      outage = value;
    },
  };
}

// v0034.12 Audit query paging and return navigation retain the same scoped results
async function auditPaging(page: Page, theme: string, width: number) {
  await page.setViewportSize(designViewport(width));
  await page.addInitScript(
    (theme) => localStorage.setItem("flowai.theme", theme),
    theme,
  );
  const fixture = await pagedAudit(page);
  await page.goto(`${proxy.baseUrl}?view=audit&team=1`);
  const rows = page.locator(
    "#audit-results tbody tr:visible,#audit-results article:visible",
  );
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText(fixture.records[0].actor_id);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText(fixture.records[10].actor_id);
  expect(fixture.reads.at(-1)?.searchParams.get("cursor")).toEqual(
    expect.any(String),
  );
  await page
    .getByRole("combobox", { name: "Rows per page", exact: true })
    .selectOption("25");
  await expect(rows).toHaveCount(25);
  expect(fixture.reads.at(-1)?.searchParams.has("cursor")).toBe(false);
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  const search = page.getByRole("textbox", {
    name: "Search action, actor, or resource",
    exact: true,
  });
  await search.fill("actor-7");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("actor-7@fixture.test");
  expect(new URL(page.url()).searchParams.get("search")).toBe("actor-7");
  expect(new URL(page.url()).searchParams.get("limit")).toBe("25");
  if (width <= 680)
    await page
      .getByRole("button", { name: /^(Open|Close) navigation$/ })
      .click();
  await page.getByRole("link", { name: "Sources", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sources", exact: true, level: 1 }),
  ).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue("actor-7");
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(search).toHaveValue("actor-7");
  await expect(rows).toHaveCount(1);
  await captureDesignState(
    page,
    test.info(),
    proxy.webUIImageID,
    `audit.html-filtered-${theme}-${width}`,
  );
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(25);
  expect(new URL(page.url()).searchParams.has("search")).toBe(false);
  expect(fixture.writes).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await captureDesignState(
    page,
    test.info(),
    proxy.webUIImageID,
    `audit-filter-pages-${theme}-${width}`,
  );
}

// v0034.12 Audit loading, unavailable and no-match states retain explicit recovery
async function auditRecovery(page: Page, theme: string, width: number) {
  await page.setViewportSize(designViewport(width));
  await page.addInitScript(
    (theme) => localStorage.setItem("flowai.theme", theme),
    theme,
  );
  const fixture = await pagedAudit(page, true);
  const root = page.locator("#audit-results");
  try {
    await page.goto(`${proxy.baseUrl}?view=audit&team=1`);
    await expect.poll(fixture.captured).toBe(true);
    await expect(root.getByRole("status")).toContainText(
      "Current team data is withheld until Gateway confirms the selected team.",
    );
    await expect(root.locator("tr,article")).toHaveCount(0);
    await captureDesignState(
      page,
      test.info(),
      proxy.webUIImageID,
      `audit.html-loading-${theme}-${width}`,
    );
    fixture.release();
    await expect(root.locator("tbody tr:visible,article:visible")).toHaveCount(
      10,
    );
    const search = page.getByRole("textbox", {
      name: "Search action, actor, or resource",
      exact: true,
    });
    fixture.setOutage(true);
    await search.fill("source");
    await expect(root.getByRole("alert")).toContainText(
      /unavailable|failed|503|connection/i,
    );
    await expect(root.getByText(/no audit records|no.*match/i)).toHaveCount(0);
    await expect(search).toHaveValue("source");
    await captureDesignState(
      page,
      test.info(),
      proxy.webUIImageID,
      `audit.html-error-${theme}-${width}`,
    );
    // Owner review 2026-10-25: no in-place Retry command; recovery
    // reloads the URL-held search.
    await expect(
      root.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    fixture.setOutage(false);
    await page.reload();
    await expect(search).toHaveValue("source");
    await expect(root.getByRole("alert")).toHaveCount(0);
    await expect(root.locator("tbody tr:visible,article:visible")).toHaveCount(
      fixture.records.filter((entry) => entry.action.includes("source")).length,
    );
    await search.fill("no-such-audit-record");
    await expect(
      root.getByRole("heading", { name: "No matching records" }),
    ).toBeVisible();
    await expect(
      root.getByText("Change or reset the current filters."),
    ).toBeVisible();
    await expect(root.locator("tbody tr:visible,article:visible")).toHaveCount(
      0,
    );
    await captureDesignState(
      page,
      test.info(),
      proxy.webUIImageID,
      `audit.html-no-results-${theme}-${width}`,
    );
    expect(fixture.writes).toEqual([]);
  } finally {
    fixture.release();
  }
}

// v0050: a task's audit entry names the task. The entry carries only the
// integer resource_id, so the name is composed from the selected team's
// canonical team_name (`alpha`) and that ID; a rejected request that named
// no existing task (resource_id null) shows the plain label `Task`.
async function auditTaskResource(
  page: Page,
  theme: string,
  width: number,
  resource_id: number | null,
) {
  await page.setViewportSize(designViewport(width));
  await page.addInitScript(
    (theme) => localStorage.setItem("flowai.theme", theme),
    theme,
  );
  for (const catalog of ["sources", "flows"])
    await page.route(`**/ui/v1/${catalog}?**`, (route) =>
      route.fulfill({ json: { items: [], next_cursor: null } }),
    );
  const entry = {
    audit_id: 9101,
    team_id: 1,
    source_service: "task-manager",
    actor_id: 7030,
    actor_type: "operator",
    action: "cancel",
    resource_type: "task",
    resource_id,
    request_id: 9102,
    outcome: resource_id === null ? "rejected" : "succeeded",
    occurred_at: "2026-10-18T00:00:03Z",
  };
  await page.route("**/ui/v1/teams/1/audit?**", (route) =>
    route.fulfill({ json: { items: [entry], next_cursor: null } }),
  );
  await page.goto(`${proxy.baseUrl}?view=audit&team=1`);
  const results = page.locator("#audit-results");
  const record = results.locator("tbody tr:visible,article:visible");
  await expect(record).toHaveCount(1);
  if (resource_id !== null) {
    const link = record.getByRole("link", {
      name: `alpha-${resource_id}`,
      exact: true,
    });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute(
      "href",
      `?view=task&team=1&id=${resource_id}`,
    );
    await expect(
      record.getByRole("link", { name: "Task", exact: true }),
    ).toHaveCount(0);
    // The bare task ID appears only inside the task name.
    expect(
      (await record.innerText()).split(`alpha-${resource_id}`).join(" "),
    ).not.toMatch(new RegExp(`(^|\\D)${resource_id}(\\D|$)`));
    return;
  }
  // The resource field reads exactly `Task`, with no link and no name.
  const resource = record.locator("td:visible,dd:visible").filter({
    hasText: /^\s*Task\s*$/,
  });
  await expect(resource).toHaveCount(1);
  await expect(resource.locator("a")).toHaveCount(0);
  await expect(record.locator('a[href*="view=task"]')).toHaveCount(0);
  await expect(record).not.toContainText("alpha-");
}

// Owner decision 2026-11-02: the four Audit checks share view, fixture, theme
// and width, so they run as steps of one test. Each step gets a fresh page
// (fresh mocked state) and every step runs before the test fails.
async function runSteps(
  context: BrowserContext,
  steps: [string, (page: Page) => Promise<void>][],
) {
  const failures: unknown[] = [];
  for (const [title, body] of steps) {
    try {
      await test.step(title, async () => {
        const page = await context.newPage();
        try {
          await body(page);
        } finally {
          await page.unrouteAll({ behavior: "wait" });
          await page.close();
        }
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} steps failed`);
}

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.12 Audit route, inspection, paging and recovery states ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout((width === 390 ? 6 : 5) * 30_000);
      const steps: [string, (page: Page) => Promise<void>][] = [
        [
          `v0034.12 Audit compatibility route preserves canonical references and safe event inspection ${theme} ${width}`,
          (page) => auditCompatibility(page, theme, width),
        ],
        [
          `v0034.12 Audit query paging and return navigation retain the same scoped results ${theme} ${width}`,
          (page) => auditPaging(page, theme, width),
        ],
        [
          `v0034.12 Audit loading, unavailable and no-match states retain explicit recovery ${theme} ${width}`,
          (page) => auditRecovery(page, theme, width),
        ],
        [
          `v0050 Audited task action names the task ${theme} ${width}`,
          (page) => auditTaskResource(page, theme, width, 1010),
        ],
        [
          `v0050 Audited task action without a task shows a plain label ${theme} ${width}`,
          (page) => auditTaskResource(page, theme, width, null),
        ],
      ];
      // The long-identity check is pinned to the phone width.
      if (width === 390)
        steps.push([
          `v0034.12 Audit inspection wraps complete long actor and request identifiers ${theme}`,
          (page) => auditLongIdentities(page, theme),
        ]);
      await runSteps(context, steps);
    });
