import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import {
  newKeyDialog,
  openSourceCommand,
  sourceDialog,
  type SourceCommand,
} from "../fixtures/approved-dialogs";
import {
  createSourceEntry,
  sourceKeyPage,
  sourceWizard,
} from "../fixtures/source-wizard";
import { flowFixture } from "../fixtures/v0034-flow";

// Survivor of task-sources-interface source-lifecycle.browser.spec.ts
// (v0041 D15). Key revocation in Registry (old key 401 after rotation) and
// the Source staying unchanged after a failed request are State Registry
// tests; here the browser sends exactly the confirmed requests.
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

const sourceID = 8034;
const sourceRecord = (name: string, enabled = true) => ({
  source_id: sourceID,
  team_id: 1,
  name,
  revision: 2,
  mode: "webhook",
  enabled,
  contract_version: "source.v1",
  implementation_version: "1",
  description: "",
  filter_summary: "",
  settings_status: "complete",
  health: "never_seen",
  polling: null,
  last_poll: null,
  webhook_url: `https://receiver.example/webhook/1/${name}/task`,
  intake_counts: {
    published: 0,
    rejected: 0,
    accepted: 0,
    deduplicated: 0,
    no_target: 0,
    failed: 0,
  },
});

test("v0013.1 / browser creates Source and keeps one-time key out of storage", async ({
  page,
}) => {
  await flowFixture(page);
  const key = ["tsk_v1", "synthetic-one-time-browser-key"].join("_");
  let created: ReturnType<typeof sourceRecord> | undefined;
  const posts: unknown[] = [];
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({
      json: { items: created ? [created] : [], next_cursor: null },
    }),
  );
  await page.route(`**/ui/v1/sources/${sourceID}`, (route) =>
    created
      ? route.fulfill({ json: created, headers: { etag: '"rev-2"' } })
      : route.fulfill({ status: 404, json: { code: "not_found" } }),
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
          webhook_url: created?.webhook_url ?? null,
        },
      },
      headers: { etag: '"rev-2"' },
    }),
  );
  await page.route("**/ui/v1/sources", (route) => {
    expect(route.request().method()).toBe("POST");
    posts.push(route.request().postDataJSON());
    created = sourceRecord("browser-source");
    return route.fulfill({
      status: 201,
      json: { source: created, api_key: key },
    });
  });
  await page.goto(`${proxy.baseUrl}/?view=sources&team=1`);
  await createSourceEntry(page).click();
  const dialog = sourceWizard(page);
  await dialog.getByLabel("Name", { exact: true }).fill("browser-source");
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByLabel("Mode", { exact: true }).selectOption("webhook");
  await dialog.locator("details summary").click();
  await dialog.getByLabel("Implementation version", { exact: true }).fill("1");
  await dialog
    .getByRole("button", { name: "Create source", exact: true })
    .click();
  const keyDialog = sourceKeyPage(page);
  await expect(keyDialog).toBeVisible();
  const shown = (
    await keyDialog.locator("[data-source-key]").textContent()
  )?.trim();
  expect(shown).toBe(key);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    name: "browser-source",
    mode: "webhook",
    implementation_version: "1",
    contract_version: "source.v1",
  });
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(key);
  expect(page.url()).not.toContain(key);
  await keyDialog
    .getByRole("button", { name: "Close and clear", exact: true })
    .click();
  await expect(page.locator("[data-source-key]")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(key);
  await expect(
    page.getByRole("link", { name: "browser-source", exact: true }).first(),
  ).toBeVisible();
  expect(page.url()).not.toContain(key);

  // Spec: Operator reloads after key creation. Neither a revisit in the same
  // page nor a reload shows the key again or recovers it from storage.
  const noKeyShown = async () => {
    await expect(
      page.getByRole("heading", { name: "browser-source", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-source-key]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(key);
    expect(page.url()).not.toContain(key);
    expect(
      await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      ),
    ).not.toContain(key);
  };
  await test.step("revisiting the Source shows no key", async () => {
    await page
      .getByRole("link", { name: "browser-source", exact: true })
      .first()
      .click();
    await noKeyShown();
  });
  await test.step("reloading and reopening the Source shows no key", async () => {
    await page.reload();
    await noKeyShown();
    await page.goto(`${proxy.baseUrl}/?view=sources&team=1`);
    await page
      .getByRole("link", { name: "browser-source", exact: true })
      .first()
      .click();
    await noKeyShown();
  });
});

test("v0013.5 / Source details are read-only and key actions need one confirmed request + adversary Source confirmations / accepted consequences, safe focus, exact typed name after failed request", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await flowFixture(page);
  let source = sourceRecord("event-source");
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
  let disableMode: "fail" | "ok" = "fail";
  let releaseDisable = () => {};
  const disableHeld = new Promise<void>(
    (resolve) => (releaseDisable = resolve),
  );
  let disableSeen = () => {};
  const disableArrived = new Promise<void>(
    (resolve) => (disableSeen = resolve),
  );
  await page.route(`**/ui/v1/sources/${sourceID}/disable`, async (route) => {
    expect(route.request().method()).toBe("POST");
    if (disableMode === "fail") {
      disableSeen();
      await disableHeld;
      return route.fulfill({
        status: 503,
        json: {
          code: "unavailable",
          message: "controlled failed confirmation request",
        },
      });
    }
    source = { ...source, enabled: false };
    return route.fulfill({ json: { source } });
  });
  await page.route(`**/ui/v1/sources/${sourceID}/rotate-key`, (route) => {
    expect(route.request().method()).toBe("POST");
    return route.fulfill({
      json: { source, api_key: ["tsk_v1", "synthetic-rotated-key"].join("_") },
    });
  });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith("/ui/v1/sources/")
    )
      writes.push(new URL(request.url()).pathname);
  });

  try {
    await test.step("adversary Source confirmations / accepted consequences, safe focus, exact typed name after failed request", async () => {
      await page.goto(`${proxy.baseUrl}/?view=source&id=${sourceID}&team=1`);
      await expect(
        page.getByRole("heading", { name: "event-source", exact: true }),
      ).toBeVisible();
      await expect(
        page
          .locator("main")
          .getByRole("button", { name: /^(Rotate key|Disable source)$/ }),
      ).toHaveCount(0);
      await page.goto(`${proxy.baseUrl}/?view=sources&team=1`);
      await expect(
        page
          .locator("#source-results")
          .getByRole("link", { name: "event-source", exact: true }),
      ).toBeVisible();
      for (const action of [
        "Rotate key",
        "Disable source",
      ] as SourceCommand[]) {
        const trigger = await openSourceCommand(page, "event-source", action);
        const dialog = sourceDialog(page, action, "event-source"),
          cancel = dialog.getByRole("button", { name: "Cancel", exact: true }),
          confirm = dialog.getByRole("button", { name: action, exact: true });
        await expect(dialog).toBeVisible();
        const text = await dialog.innerText();
        expect(text, `${action}: source canonical name`).toContain(
          "event-source",
        );
        expect(text, `${action}: source mode`).toMatch(/webhook/i);
        await expect(
          cancel,
          `${action}: Cancel has initial focus`,
        ).toBeFocused();
        await expect(confirm, `${action}: destructive style`).toHaveClass(
          /\bdanger\b/,
        );
        if (action === "Rotate key") {
          expect(text).toMatch(/(immediately|immediate)/i);
          expect(text).toMatch(
            /(source control|control (and webhook )?requests)/i,
          );
          expect(text).toMatch(/polls? continue|poll calls continue/i);
          expect(text).toMatch(
            /accepted tasks[\s\S]*settings[\s\S]*(kept|preserv|remain)/i,
          );
          expect(text).toMatch(/once/i);
        } else {
          await expect(confirm).toBeDisabled();
          const name = dialog.getByLabel("Type exact source name", {
            exact: true,
          });
          await name.fill("wrong-source");
          await expect(confirm).toBeDisabled();
          await name.fill("event-source");
          await expect(confirm).toBeEnabled();
          expect(text).toMatch(/cannot be undone|can't be undone|irreversib/i);
          expect(text).toMatch(/polls? stop/i);
          expect(text).toMatch(/webhook.*reject/i);
          expect(text).toMatch(/accepted tasks[\s\S]*(kept|preserv|remain)/i);
          expect(text).toMatch(
            /(event-source\s+stays\s+reserved|name\s+(stays|remains)\s+(taken|reserved))/i,
          );
        }
        await cancel.click();
        await expect(dialog).toHaveCount(0);
        await expect(trigger, `${action}: focus after Cancel`).toBeFocused();
        await openSourceCommand(page, "event-source", action);
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(trigger, `${action}: focus after Escape`).toBeFocused();
      }
      expect(writes, "Cancel and Escape send no Source mutation").toEqual([]);

      await openSourceCommand(page, "event-source", "Disable source");
      const dialog = sourceDialog(page, "Disable source", "event-source"),
        confirm = dialog.getByRole("button", {
          name: "Disable source",
          exact: true,
        }),
        name = dialog.getByLabel("Type exact source name", { exact: true });
      await name.fill("event-source");
      await confirm.click();
      await disableArrived;
      expect(writes).toHaveLength(1);
      await expect(confirm).toBeDisabled();
      await name.fill("wrong-source");
      releaseDisable();
      await expect(
        dialog
          .getByRole("alert")
          .filter({ hasText: "Check the connection and retry." }),
      ).toBeVisible();
      await expect(
        confirm,
        "failed request must not enable Disable with a wrong current name",
      ).toBeDisabled();
      expect(writes, "no second Disable request").toHaveLength(1);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    });

    await test.step("v0013.5 / Source details are read-only and key actions need one confirmed request", async () => {
      writes.length = 0;
      disableMode = "ok";
      await page.goto(`${proxy.baseUrl}/?view=source&id=${sourceID}&team=1`);
      await expect(
        page.getByRole("heading", { name: "event-source", exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(
          "#source-detail input,#source-detail textarea,#source-detail select",
        ),
      ).toHaveCount(0);
      await expect(
        page
          .locator("main")
          .getByRole("button", { name: /^(Rotate key|Disable source)$/ }),
      ).toHaveCount(0);
      await page.goto(`${proxy.baseUrl}/?view=sources&team=1`);
      await openSourceCommand(page, "event-source", "Rotate key");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(writes).toHaveLength(0);
      await openSourceCommand(page, "event-source", "Rotate key");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      expect(writes).toHaveLength(0);
      await openSourceCommand(page, "event-source", "Rotate key");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Rotate key", exact: true })
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      const key = newKeyDialog(page, "event-source");
      await expect(key).toBeVisible();
      await expect(page.locator("[data-source-key]")).toHaveText(
        ["tsk_v1", "synthetic-rotated-key"].join("_"),
      );
      expect(writes).toEqual([`/ui/v1/sources/${sourceID}/rotate-key`]);
      expect(
        await page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
          }),
        ),
      ).not.toContain(["tsk_v1", "synthetic-rotated-key"].join("_"));
      await key
        .getByRole("button", { name: "Close and clear", exact: true })
        .click();
      await expect(key).toHaveCount(0);
      await expect(page.locator("[data-source-key]")).toHaveCount(0);
      await openSourceCommand(page, "event-source", "Disable source");
      const disable = sourceDialog(page, "Disable source", "event-source");
      await disable
        .getByLabel("Type exact source name", { exact: true })
        .fill("wrong");
      await expect(
        disable.getByRole("button", { name: "Disable source", exact: true }),
      ).toBeDisabled();
      await disable
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(writes).toHaveLength(1);
      await openSourceCommand(page, "event-source", "Disable source");
      await page
        .getByRole("dialog")
        .getByLabel("Type exact source name", { exact: true })
        .fill("event-source");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Disable source", exact: true })
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      await expect(page.locator("#source-results")).toContainText("Disabled");
      expect(writes).toEqual([
        `/ui/v1/sources/${sourceID}/rotate-key`,
        `/ui/v1/sources/${sourceID}/disable`,
      ]);
      await page.goto(`${proxy.baseUrl}/?view=source&id=${sourceID}&team=1`);
      await expect(page.locator("#source-detail")).toContainText("Disabled");
    });
  } finally {
    releaseDisable();
  }
});
