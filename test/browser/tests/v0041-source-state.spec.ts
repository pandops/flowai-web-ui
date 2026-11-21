import path from "node:path";
import type { Page, Request } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture } from "../fixtures/v0034-flow";

// Survivor of task-sources-interface v0034-source-state.browser.spec.ts
// (v0041 D15): the Source editor's impact links, exact poll replacement write
// bodies and save ordering while Flow names are pending. Registry application
// of the written poll_url/interval values is a State Registry test.
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

const sourceID = 8015;
const flowOne = 8018;
const flowTwo = 8019;

async function sourceEditorFixture(page: Page) {
  await flowFixture(page);
  const platform: Record<string, unknown> = {
    poll_url: "https://poller.example/poll",
    poll_interval_minutes: 7,
    webhook_url: null,
  };
  let revision = 3;
  const source = () => ({
    source_id: sourceID,
    team_id: 1,
    name: "event-source",
    revision,
    mode: "poller",
    enabled: true,
    contract_version: "source.v1",
    implementation_version: "1",
    description: "",
    filter_summary: "",
    settings_status: "complete",
    health: "healthy",
    last_seen_at: "2026-10-18T00:00:00Z",
    polling: {
      polling_blocked_at: null,
      consecutive_failures: 0,
      next_poll_at: "2026-10-20T12:00:00Z",
    },
    last_poll: null,
    webhook_url: null,
    intake_counts: {
      published: 0,
      rejected: 0,
      accepted: 0,
      deduplicated: 0,
      no_target: 0,
      failed: 0,
    },
  });
  const settings = () => ({
    source_id: sourceID,
    mode: "poller",
    revision,
    settings_status: "complete",
    fields: [],
    platform: { ...platform },
  });
  const flows = [flowOne, flowTwo].map((flow_id, index) => ({
    flow_id,
    name: index === 0 ? "Flow one" : "Flow two",
    revision: 1,
    execution_tag: "openhands",
    model_aliases: ["1/first"],
    prompt_template: "Work {{external_id}}",
    execution_parameters: {},
    default_image: null,
    source_ids: [sourceID],
    source_revisions: { [sourceID]: 3 },
    per_task_limit: null,
    flow_limit: null,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
  }));
  let holdFlows: Promise<void> | undefined;
  await page.route("**/ui/v1/flows?**", async (route) => {
    if (holdFlows) await holdFlows;
    await route.fulfill({ json: { items: flows, next_cursor: null } });
  });
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({ json: { items: [source()], next_cursor: null } }),
  );
  const sourceReads: string[] = [];
  await page.route(`**/ui/v1/sources/${sourceID}`, (route) => {
    sourceReads.push("source");
    return route.fulfill({
      json: source(),
      headers: { etag: `"rev-${revision}"` },
    });
  });
  const writes: { body: any; etag?: string; current: string }[] = [];
  await page.route(`**/ui/v1/sources/${sourceID}/settings`, (route) => {
    if (route.request().method() === "GET") {
      sourceReads.push("settings");
      return route.fulfill({
        json: settings(),
        headers: { etag: `"rev-${revision}"` },
      });
    }
    expect(route.request().method()).toBe("PUT");
    const body = route.request().postDataJSON();
    writes.push({
      body,
      etag: route.request().headers()["if-match"],
      current: `"rev-${revision}"`,
    });
    for (const key of ["poll_url", "poll_interval_minutes"])
      if (key in body) platform[key] = body[key];
    revision++;
    return route.fulfill({
      json: settings(),
      headers: { etag: `"rev-${revision}"` },
    });
  });
  return {
    writes,
    sourceReads,
    platform,
    hold: (held: Promise<void>) => (holdFlows = held),
  };
}

for (const theme of ["dark", "light"] as const) {
  test(`v0034.13 Source editor impact links and poll replacement states ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("flowai.theme", value),
      theme,
    );
    const { writes, platform } = await sourceEditorFixture(page);
    await test.step(`v0034.13 Source editor impact links ${theme}`, async () => {
      const all: string[] = [];
      const record = (request: Request) => {
        if (
          request.method() !== "GET" &&
          new URL(request.url()).pathname.startsWith("/ui/v1/")
        )
          all.push(request.url());
      };
      page.on("request", record);
      await page.goto(
        `${proxy.baseUrl}/?view=source-edit&id=${sourceID}&team=1`,
      );
      await expect(
        page.getByRole("heading", {
          name: "Edit source · event-source",
          exact: true,
        }),
      ).toBeVisible();
      for (const [name, id] of [
        ["Flow one", flowOne],
        ["Flow two", flowTwo],
      ]) {
        const link = page
          .locator("main")
          .getByRole("link", { name: String(name), exact: true });
        await expect(link).toBeVisible();
        expect(
          new URL(
            (await link.getAttribute("href"))!,
            page.url(),
          ).searchParams.get("id"),
        ).toBe(String(id));
      }
      expect(writes).toEqual([]);
      expect(all).toEqual([]);
      page.off("request", record);
    });
    // The impact-link step writes nothing, so the fixture state is unchanged.
    await test.step(`v0034.13 Source editor poll replacement states ${theme}`, async () => {
      await page.goto(
        `${proxy.baseUrl}/?view=source-edit&id=${sourceID}&team=1`,
      );
      await expect(
        page.getByRole("heading", {
          name: "Edit source · event-source",
          exact: true,
        }),
      ).toBeVisible();
      const urlState = page.getByLabel("Poll URL value state", { exact: true });
      const intervalState = page.getByLabel("Poll interval value state", {
        exact: true,
      });
      await expect(urlState).toHaveValue("keep");
      await expect(intervalState).toHaveValue("keep");
      const save = async (count: number) => {
        await page
          .getByRole("button", { name: "Save source", exact: true })
          .click();
        await expect.poll(() => writes.length).toBe(count);
        await expect(page.locator("[data-source-save-status]")).toContainText(
          "Source saved",
        );
      };
      await save(1);
      expect(writes[0]).toEqual({
        body: { values: {} },
        etag: '"rev-3"',
        current: '"rev-3"',
      });
      await urlState.selectOption("null");
      await save(2);
      expect(writes[1].body).toEqual({ values: {}, poll_url: null });
      await urlState.selectOption("keep");
      await intervalState.selectOption("set");
      await page
        .getByLabel("Poll interval override", { exact: true })
        .fill("0");
      await page
        .getByRole("button", { name: "Save source", exact: true })
        .click();
      // An invalid interval is rejected in the browser: no write.
      await page.waitForTimeout(500);
      expect(writes).toHaveLength(2);
      await page
        .getByLabel("Poll interval override", { exact: true })
        .fill("13");
      await save(3);
      expect(writes[2].body).toEqual({ values: {}, poll_interval_minutes: 13 });
      await intervalState.selectOption("null");
      await urlState.selectOption("set");
      await page
        .getByLabel("Poll URL override", { exact: true })
        .fill("https://poller.example/replacement");
      await save(4);
      expect(writes[3].body).toEqual({
        values: {},
        poll_url: "https://poller.example/replacement",
        poll_interval_minutes: null,
      });
      // Every write carries the revision the editor last read.
      for (const write of writes) expect(write.etag).toBe(write.current);
      expect(platform).toMatchObject({
        poll_url: "https://poller.example/replacement",
        poll_interval_minutes: null,
      });
      await page
        .getByLabel("Poll URL override", { exact: true })
        .fill("invalid URL");
      await page
        .getByRole("button", { name: "Save source", exact: true })
        .click();
      await expect(
        page.locator("#source-settings-form .validation"),
      ).toContainText(/URL/i);
      expect(writes).toHaveLength(4);
    });
    await test.step(`v0034.13 Operator edits shared Source settings used by several Flows ${theme}`, async () => {
      const nonGet: string[] = [];
      const record = (request: Request) => {
        if (
          request.method() !== "GET" &&
          new URL(request.url()).pathname.startsWith("/ui/v1/")
        )
          nonGet.push(`${request.method()} ${new URL(request.url()).pathname}`);
      };
      page.on("request", record);
      try {
        await page.goto(
          `${proxy.baseUrl}/?view=source-edit&id=${sourceID}&team=1`,
        );
        const before = writes.length;
        await page
          .getByRole("button", { name: "Save source", exact: true })
          .click();
        await expect.poll(() => writes.length).toBe(before + 1);
        await expect(page.locator("[data-source-save-status]")).toContainText(
          "Source saved",
        );
        // One Source write; no Flow write; both Flows stay bound.
        expect(nonGet).toEqual([`PUT /ui/v1/sources/${sourceID}/settings`]);
        for (const name of ["Flow one", "Flow two"])
          await expect(
            page.locator("main").getByRole("link", { name, exact: true }),
          ).toBeVisible();
        expect(writes.at(-1)!.body).not.toHaveProperty("flow_ids");
      } finally {
        page.off("request", record);
      }
    });
  });

  test(`v0034.13 Source editor pending Flow names ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("flowai.theme", value),
      theme,
    );
    const { writes, sourceReads, hold } = await sourceEditorFixture(page);
    let release = () => {};
    hold(new Promise<void>((resolve) => (release = resolve)));
    try {
      await page.goto(
        `${proxy.baseUrl}/?view=source-edit&id=${sourceID}&team=1`,
      );
      await expect(page.locator("#source-settings-form")).toBeVisible();
      await expect
        .poll(() => [...new Set(sourceReads)].sort())
        .toEqual(["settings", "source"]);
      await page
        .getByRole("button", { name: "Save source", exact: true })
        .click();
      await expect(page.locator("[data-source-save-status]")).toContainText(
        "Source saved",
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].body).toEqual({ values: {} });
      await page
        .getByLabel("Poll interval value state", { exact: true })
        .selectOption("set");
      await page
        .getByLabel("Poll interval override", { exact: true })
        .fill("19");
      release();
      await expect(
        page.getByRole("link", { name: "Flow one", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Poll interval override", { exact: true }),
      ).toHaveValue("19");
      expect(writes).toHaveLength(1);
    } finally {
      release();
    }
  });
}
