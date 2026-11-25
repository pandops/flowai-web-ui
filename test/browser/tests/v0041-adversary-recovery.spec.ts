import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import {
  newKeyDialog,
  openSourceCommand,
  sourceOutcomeDialog,
} from "../fixtures/approved-dialogs";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivor of task-sources-interface adversary-recovery.browser.spec.ts
// (v0041 D15). Registry halves (old key revoked, new key accepted; missing
// and foreign identifiers answer the same 404) live in State Registry tests.
test.use({ actionTimeout: 10_000 });

const teamID = 1,
  sourceID = 8020,
  flowID = 8021;
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: teamID, team_name: "intake" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

function sourceAt(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    source_id: sourceID,
    team_id: teamID,
    name: "event-source",
    revision,
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
    webhook_url: "https://receiver.example/webhook/1/event-source/task",
    intake_counts: {
      published: 0,
      rejected: 0,
      accepted: 0,
      deduplicated: 0,
      no_target: 0,
      failed: 0,
    },
    ...overrides,
  };
}

async function catalogApi(page: Page, current: () => any) {
  await page.route("**/ui/v1/**", async (route) => {
    const request = route.request(),
      p = new URL(request.url()).pathname;
    if (request.method() !== "GET") return route.fallback();
    if (p === "/ui/v1/sources")
      return route.fulfill({ json: { items: [current()], next_cursor: null } });
    if (p === `/ui/v1/sources/${sourceID}`)
      return route.fulfill({
        json: current(),
        headers: { etag: `"rev-${current().revision}"` },
      });
    if (p === `/ui/v1/sources/${sourceID}/settings`)
      return route.fulfill({
        json: {
          source_id: sourceID,
          mode: "webhook",
          revision: current().revision,
          settings_status: current().settings_status,
          fields: [],
          platform: {
            poll_url: null,
            poll_interval_minutes: null,
            webhook_url: current().webhook_url,
          },
        },
        headers: { etag: `"rev-${current().revision}"` },
      });
    if (p === "/ui/v1/flows")
      return route.fulfill({
        json: {
          items: [
            { flow_id: flowID, name: "Flow one", source_ids: [sourceID] },
          ],
          next_cursor: null,
        },
      });
    if (p === "/ui/v1/flow-llm-settings")
      return route.fulfill({ json: { items: [], next_cursor: null } });
    return route.fallback();
  });
}

// One test, one step per original check. Each step starts from a blank
// document and removes its routes when it ends; the steps read different
// Source identifiers.
test("adversary recovery / missing and foreign Sources have the same unavailable view; implementation update cancel, stale revision, double confirm and transient rotated key · Web UI unit", async ({
  page,
}) => {
  for (const [title, body] of [
    [
      "adversary recovery / missing and foreign Sources have the same unavailable view · Web UI unit",
      async () => {
        const missing = 8022,
          foreign = 8023;
        // API Gateway forwards the Registry's single non-revealing 404 for both.
        await page.route(
          /\/ui\/v1\/sources\/[^/?]+(?:\/settings)?(?:\?.*)?$/,
          (route) =>
            route.fulfill({
              status: 404,
              json: { code: "not_found", message: "resource not found" },
            }),
        );
        await page.route(
          /\/ui\/v1\/(?:sources|flows|flow-llm-settings)(?:\?.*)?$/,
          (route) => route.fulfill({ json: { items: [], next_cursor: null } }),
        );
        const unavailable: string[] = [];
        for (const id of [missing, foreign]) {
          const response = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === `/ui/v1/sources/${id}`,
          );
          await page.goto(
            `${proxy.baseUrl}/?view=source&id=${id}&team=${teamID}`,
          );
          expect((await response).status()).toBe(404);
          await expect(page.locator("#source-detail")).toContainText(
            "This identifier is unavailable to the selected team.",
          );
          await expect(page.locator("[data-source-action]")).toHaveCount(0);
          unavailable.push(await page.locator("#source-detail").innerText());
        }
        expect(unavailable[0]).toBe(unavailable[1]);
      },
    ],
    [
      "adversary recovery / implementation update cancel, stale revision, double confirm and transient rotated key · Web UI unit",
      async () => {
        // The Source is at revision 2 when the dialog opens; a schema publication
        // then advances it to 3, so the first confirm is stale.
        let source = sourceAt(2);
        await catalogApi(page, () => source);
        const requestPath = `/ui/v1/sources/${sourceID}/implementation`;
        const writes: { etag?: string; body: unknown }[] = [];
        const otherWrites: string[] = [];
        page.on("request", (request) => {
          const p = new URL(request.url()).pathname;
          if (
            ["GET", "HEAD"].includes(request.method()) ||
            !p.startsWith("/ui/v1/")
          )
            return;
          if (p === requestPath && request.method() === "PATCH")
            writes.push({
              etag: request.headers()["if-match"],
              body: request.postDataJSON(),
            });
          else otherWrites.push(`${request.method()} ${p}`);
        });
        const rotatedKey = [
          "tsk_v1",
          "synthetic-rotated-implementation-key",
        ].join("_");
        await page.route(`**${requestPath}`, async (route) => {
          const etag = route.request().headers()["if-match"];
          if (etag !== `"rev-${source.revision}"`)
            return route.fulfill({
              status: 412,
              json: {
                code: "precondition_failed",
                message: "revision changed",
              },
            });
          source = sourceAt(source.revision + 1, {
            implementation_version: "2",
            settings_status: "awaiting_schema",
          });
          return route.fulfill({ json: { source, api_key: rotatedKey } });
        });

        // Source detail is read-only; the implementation update is a Sources
        // catalog record command.
        await page.goto(
          `${proxy.baseUrl}/?view=source&id=${sourceID}&team=${teamID}`,
        );
        await expect(
          page.getByRole("heading", { name: "event-source", exact: true }),
        ).toBeVisible();
        await expect(
          page.locator("main").getByRole("button", {
            name: "Update implementation version",
            exact: true,
          }),
        ).toHaveCount(0);
        await page.goto(`${proxy.baseUrl}/?view=sources&team=${teamID}`);
        await expect(
          page
            .locator("#source-results")
            .getByRole("link", { name: "event-source", exact: true }),
        ).toBeVisible();
        const open = async () => {
          await openSourceCommand(page, "event-source", "Update version");
          await expect(page.getByRole("dialog")).toBeVisible();
        };
        await open();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await open();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(writes).toHaveLength(0);

        await open();
        source = sourceAt(3); // concurrent schema publication
        await page
          .getByRole("dialog")
          .getByLabel("Implementation version", { exact: true })
          .fill("2");
        const stale = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === requestPath &&
            response.request().method() === "PATCH",
        );
        await page
          .getByRole("dialog")
          .getByRole("button", {
            name: "Update implementation version",
            exact: true,
          })
          .click();
        expect((await stale).status()).toBe(412);
        const staleOutcome = sourceOutcomeDialog(
          page,
          "source-version-412",
          "event-source",
        );
        await expect(staleOutcome.getByRole("alert")).toContainText(
          "Reload the current Source and revision",
        );
        await expect(staleOutcome).not.toContainText(/updated|saved/i);
        await staleOutcome
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(staleOutcome).toHaveCount(0);
        await page.reload();
        await expect(
          page
            .locator("#source-results")
            .getByRole("link", { name: "event-source", exact: true }),
        ).toBeVisible();
        await open();
        await page
          .getByRole("dialog")
          .getByLabel("Implementation version", { exact: true })
          .fill("2");
        await page
          .getByRole("dialog")
          .getByRole("button", {
            name: "Update implementation version",
            exact: true,
          })
          .evaluate((button: HTMLButtonElement) => {
            button.click();
            button.click();
          });
        const keyDialog = newKeyDialog(page, "event-source");
        await expect(keyDialog).toBeVisible();
        // One stale confirm plus exactly one request for the double confirm; the
        // retry carries the reloaded revision.
        expect(writes).toEqual([
          { etag: '"rev-2"', body: { implementation_version: "2" } },
          { etag: '"rev-3"', body: { implementation_version: "2" } },
        ]);
        await expect(keyDialog.locator("[data-source-key]")).toHaveText(
          rotatedKey,
        );
        expect(
          await page.evaluate(() =>
            JSON.stringify({
              local: { ...localStorage },
              session: { ...sessionStorage },
            }),
          ),
        ).not.toContain(rotatedKey);
        expect(page.url()).not.toContain(rotatedKey);
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-source-key]")).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText(rotatedKey);
        await expect(page.locator("#source-results")).toContainText(
          /awaiting schema/i,
        );
        expect(otherWrites).toEqual([]);
      },
    ],
  ] as const)
    await test.step(title, async () => {
      await page.goto("about:blank");
      try {
        await body();
      } finally {
        await page.goto("about:blank");
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }
    });
});
