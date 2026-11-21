import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivors of task-sources-interface source-empty-value.browser.spec.ts and
// source-numeric.browser.spec.ts (v0041 D15). The Web UI half is the exact
// settings write it sends from the standalone Source editor; Registry jsonb
// storage of "" vs null and of exact large numbers is not asserted here.
// Also the survivor of task-sources-interface poll-default.browser.spec.ts
// (v0041 D15): an unconfigured poller editor pre-fills and sends an explicit
// five-minute interval. Registry next_poll_at scheduling one interval after
// save is not asserted here.

const team = 1;
const sourceID = 8013;

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: team, team_name: "intake" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

// Registry settings projections carry the effective value (the schema
// default when no value is stored). Bodies are raw text so exact numeric
// literals reach the browser unrounded.
async function mockSource(
  page: Page,
  fieldsJSON: string,
  savedFieldsJSON: string,
) {
  const source = {
    source_id: sourceID,
    name: "event-source",
    team_id: team,
    revision: 2,
    mode: "webhook",
    enabled: true,
    contract_version: "source.v1",
    implementation_version: "1",
    description: "",
    filter_summary: "",
    settings_status: "complete",
    health: "healthy",
    last_seen_at: null,
    polling: null,
    last_poll: null,
  };
  const settings = (revision: number, fields: string) =>
    `{"source_id":${sourceID},"mode":"webhook","settings_status":"complete","schema_revision":1,"revision":${revision},"platform":{"webhook_url":"https://receiver.example/webhook/1/event-source/task"},"fields":${fields},"polling":null,"last_poll":null}`;
  const puts: { body: string | null; ifMatch: string | undefined }[] = [];
  await page.route(`**/ui/v1/sources/${sourceID}`, (route) =>
    route.fulfill({ json: source, headers: { etag: '"rev-2"' } }),
  );
  await page.route(`**/ui/v1/sources/${sourceID}/settings`, (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: settings(2, fieldsJSON),
        headers: { etag: '"rev-2"' },
      });
    expect(request.method()).toBe("PUT");
    puts.push({
      body: request.postData(),
      ifMatch: request.headers()["if-match"],
    });
    return route.fulfill({
      contentType: "application/json",
      body: settings(3, savedFieldsJSON),
      headers: { etag: '"rev-3"' },
    });
  });
  return puts;
}

// An unconfigured poller: no stored poll URL or interval.
async function mockPoller(page: Page) {
  const source = {
    source_id: sourceID,
    name: "event-source",
    team_id: team,
    revision: 2,
    mode: "poller",
    enabled: true,
    contract_version: "source.v1",
    implementation_version: "1",
    description: "",
    filter_summary: "",
    settings_status: "complete",
    health: "healthy",
    last_seen_at: null,
    polling: {
      polling_blocked_at: null,
      consecutive_failures: 0,
      next_poll_at: null,
    },
    last_poll: null,
  };
  const settings = (
    revision: number,
    platform: {
      poll_url: string | null;
      poll_interval_minutes: number | null;
    },
  ) => ({
    source_id: sourceID,
    mode: "poller",
    settings_status: "complete",
    schema_revision: 1,
    revision,
    platform: { ...platform },
    fields: [],
    polling: source.polling,
    last_poll: null,
  });
  const puts: (string | null)[] = [];
  await page.route(`**/ui/v1/sources/${sourceID}`, (route) =>
    route.fulfill({ json: source, headers: { etag: '"rev-2"' } }),
  );
  await page.route(`**/ui/v1/sources/${sourceID}/settings`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: settings(2, { poll_url: null, poll_interval_minutes: null }),
        headers: { etag: '"rev-2"' },
      });
    puts.push(route.request().postData());
    return route.fulfill({
      json: settings(3, {
        poll_url: "https://poller.example/poll",
        poll_interval_minutes: 5,
      }),
      headers: { etag: '"rev-3"' },
    });
  });
  return puts;
}

// Every step replaces the Source routes with fresh ones and loads its own
// editor, so no step sees another step's writes.
async function freshSource<T>(page: Page, mock: () => Promise<T>) {
  await page.unrouteAll({ behavior: "wait" });
  return mock();
}

test("v0013.6 / Source editor writes preserve empty string, exact large number/integer defaults and the five-minute poll default", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await test.step("v0013.6 / unrelated field edit preserves required empty string distinct from null", async () => {
    const puts = await freshSource(page, () =>
      mockSource(
        page,
        '[{"name":"token","label":"Token","type":"string","required":true,"default":"","value":""},{"name":"flag","label":"Flag","type":"boolean","required":false,"default":false,"value":false}]',
        '[{"name":"token","label":"Token","type":"string","required":true,"default":"","value":""},{"name":"flag","label":"Flag","type":"boolean","required":false,"default":false,"value":true}]',
      ),
    );
    await page.goto(
      `${proxy.baseUrl}/?view=source-edit&id=${sourceID}&team=${team}`,
    );
    const form = page.locator("#source-settings-form");
    await expect(
      form.getByLabel("Flag value state", { exact: true }),
    ).toBeVisible();
    // The required empty string is a set value, not Not set (null).
    await expect(
      form.getByLabel("Token value state", { exact: true }),
    ).toHaveValue("set");
    await expect(
      form.getByLabel("Token override", { exact: true }),
    ).toHaveValue("");
    await form
      .getByLabel("Flag value state", { exact: true })
      .selectOption("set");
    await form
      .getByLabel("Flag override", { exact: true })
      .selectOption("true");
    await form
      .getByRole("button", { name: "Save source", exact: true })
      .click();
    await expect(page.locator("[data-source-save-status]")).toContainText(
      "Source saved",
    );
    expect(puts).toEqual([
      { body: '{"values":{"token":"","flag":true}}', ifMatch: '"rev-2"' },
    ]);
  });

  for (const kind of ["number", "integer"])
    await test.step(`v0013.6 / changing another shared field preserves an exact large ${kind} default`, async () => {
      const puts = await freshSource(page, () =>
        mockSource(
          page,
          `[{"name":"counter","label":"Counter","type":"${kind}","required":false,"default":9007199254740993,"value":9007199254740993},{"name":"label","label":"Label","type":"string","required":false,"default":"original","value":"original"}]`,
          `[{"name":"counter","label":"Counter","type":"${kind}","required":false,"default":9007199254740993,"value":9007199254740993},{"name":"label","label":"Label","type":"string","required":false,"default":"original","value":"changed"}]`,
        ),
      );
      await page.goto(
        `${proxy.baseUrl}/?view=source-edit&id=${sourceID}&team=${team}`,
      );
      const form = page.locator("#source-settings-form");
      await expect(
        form.getByLabel("Counter override", { exact: true }),
      ).toHaveValue("9007199254740993");
      await form
        .getByLabel("Label value state", { exact: true })
        .selectOption("set");
      await form.getByLabel("Label override", { exact: true }).fill("changed");
      await form
        .getByRole("button", { name: "Save source", exact: true })
        .click();
      await expect(page.locator("[data-source-save-status]")).toContainText(
        "Source saved",
      );
      // The write carries the exact literal, never a float-rounded ...992.
      expect(puts).toEqual([
        {
          body: '{"values":{"counter":9007199254740993,"label":"changed"}}',
          ifMatch: '"rev-2"',
        },
      ]);
      // The saved projection is shown unrounded as well.
      await expect(
        form.getByLabel("Counter override", { exact: true }),
      ).toHaveValue("9007199254740993");
    });

  await test.step("v0013.6 / unconfigured poller editor starts with five-minute interval", async () => {
    const puts = await freshSource(page, () => mockPoller(page));
    // v0034 edits poll settings only in the standalone Source editor.
    await page.goto(
      `${proxy.baseUrl}/?view=source-edit&id=${sourceID}&team=${team}`,
    );
    const form = page.locator("#source-settings-form");
    await expect(
      form.getByLabel("Poll interval override", { exact: true }),
    ).toHaveValue("5");
    await expect(
      form.getByLabel("Poll interval value state", { exact: true }),
    ).toHaveValue("set");
    await form
      .getByLabel("Poll URL value state", { exact: true })
      .selectOption("set");
    await form
      .getByLabel("Poll URL override", { exact: true })
      .fill("https://poller.example/poll");
    await form
      .getByRole("button", { name: "Save source", exact: true })
      .click();
    await expect(page.locator("[data-source-save-status]")).toContainText(
      "Source saved",
    );
    expect(puts).toEqual([
      '{"poll_url":"https://poller.example/poll","poll_interval_minutes":5,"values":{}}',
    ]);
    await expect(
      form.getByLabel("Poll interval override", { exact: true }),
    ).toHaveValue("5");
  });
});
