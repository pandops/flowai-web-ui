import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowEditor, saveFlow } from "../fixtures/flow-editor";
import { flowFixture, flowID } from "../fixtures/v0034-flow";

// Survivor of task-sources-interface v0034-flow-editor.browser.spec.ts
// (v0041 D15): read-only Flow detail, Source binding by checkbox with
// separate Inspect/Edit commands, and the exact Flow write body. That the
// shared Source settings stay unchanged in Registry is a State Registry test;
// here the browser must send no Source write at all.
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

const sourceID = 8035;

for (const theme of ["dark", "light"] as const)
  test(`v0034.6 Flow identity is read-only and its editor only binds existing Sources ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("flowai.theme", value),
      theme,
    );
    const { writes, flows } = await flowFixture(page);
    Object.assign(flows.get(flowID)!, {
      name: "Flow one",
      source_ids: [sourceID],
      source_revisions: { [sourceID]: 2 },
    });
    const source = {
      source_id: sourceID,
      team_id: 1,
      name: "event-source",
      revision: 2,
      mode: "webhook",
      enabled: true,
      contract_version: "source.v1",
      implementation_version: "1",
      description: "",
      filter_summary: "",
      settings_status: "complete",
      health: "never_seen",
      polling: null,
      last_poll: null,
      webhook_url: "https://receiver.example/webhook/1/event-source/task",
      intake_counts: {
        published: 0,
        rejected: 0,
        accepted: 0,
        deduplicated: 0,
        no_target: 0,
        failed: 0,
      },
    };
    await page.route("**/ui/v1/sources?**", (route) =>
      route.fulfill({ json: { items: [source], next_cursor: null } }),
    );
    await page.route(`**/ui/v1/sources/${sourceID}`, (route) =>
      route.fulfill({ json: source, headers: { etag: '"rev-2"' } }),
    );
    await page.route(`**/ui/v1/sources/${sourceID}/settings`, (route) =>
      route.fulfill({
        json: {
          source_id: sourceID,
          mode: "webhook",
          revision: 2,
          settings_status: "complete",
          fields: [],
          platform: {
            poll_url: null,
            poll_interval_minutes: null,
            webhook_url: source.webhook_url,
          },
        },
        headers: { etag: '"rev-2"' },
      }),
    );
    await page.goto(`${proxy.baseUrl}/?view=flows&team=1`);
    const identity = page
      .getByRole("link", { name: "Flow one", exact: true })
      .first();
    await expect(identity).toBeVisible();
    await identity.click();
    await expect(
      page.getByRole("heading", { name: "Flow detail", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("main")).toContainText("Flow one");
    expect(new URL(page.url()).searchParams.get("id")).toBe(String(flowID));
    expect(writes).toEqual([]);
    await expect(
      page.getByRole("link", { name: "event-source", exact: true }).first(),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Flow detail", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Edit flow", exact: true }).click();
    const dialog = flowEditor(page);
    await expect(dialog).toBeVisible();
    // The Flow editor never edits shared Source configuration.
    await expect(
      dialog.locator(
        "[data-registered-field],[data-poll-url],[data-poll-interval]",
      ),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("checkbox", { name: "event-source", exact: true }),
    ).toBeChecked();
    // Inspection and editing are separate commands: a canonical Inspect link
    // and an Edit source command in the Source's action menu.
    await expect(
      dialog.getByRole("link", { name: "Inspect source", exact: true }),
    ).toHaveAttribute("href", new RegExp(`view=source&.*id=${sourceID}`));
    await dialog.getByLabel("Name", { exact: true }).fill("Flow renamed");
    await saveFlow(dialog).click();
    await expect(dialog).not.toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`/ui/v1/flows/${flowID}`);
    expect(writes[0].etag).toBe('"1"');
    expect(writes[0].body).not.toHaveProperty("source_settings");
    expect(writes[0].body.name).toBe("Flow renamed");
    expect(writes[0].body.source_ids).toEqual([sourceID]);
    expect(writes[0].body.source_revisions).toEqual({ [sourceID]: 2 });

    await page.goto(`${proxy.baseUrl}/?view=flows&team=1&id=${flowID}`);
    const editor = flowEditor(page);
    await expect(editor).toBeVisible();
    await editor
      .getByRole("button", { name: "Actions for event-source", exact: true })
      .click();
    await page
      .getByRole("menu", { name: "Actions for event-source", exact: true })
      .getByRole("menuitem", { name: "Edit source", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`view=source-edit.*id=${sourceID}`),
    );
    expect(writes).toHaveLength(1);
  });
