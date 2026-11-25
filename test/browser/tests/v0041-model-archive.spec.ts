import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { modelDialog } from "../fixtures/approved-dialogs";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivor of llm-proxying v0022.14-model-archive.ui.spec.ts (v0041 D15).
// The State Registry projection the original flow produced (two team models,
// a Flow selecting only m1) is served by a stateful mocked /ui/v1 catalog.

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

const soloFlow = {
  flow_id: 8009,
  name: "only-m1",
};

async function catalog(page: Page) {
  const models = new Map(
    ["m1", "m2"].map((name) => [
      name,
      {
        name,
        model_alias: `1/${name}`,
        provider: "openai",
        provider_model: "x",
        api_base: "https://fixture-provider.invalid/v1",
        credential_configured: false,
        created_by: "team",
        model_id: 6000 + name.charCodeAt(name.length - 1),
        created_at: "2026-10-18T00:00:00Z",
        updated_at: "2026-10-18T00:00:00Z",
        unfinished_task_count: 0,
        paused: false,
        archived_at: null as string | null,
        editable: true,
        can_archive: name !== "m1",
        can_unarchive: false,
        archive_blocking_flows: name === "m1" ? [soloFlow] : [],
        pricing_status: "configured",
        pricing: {
          input_usd_per_million_tokens: "1",
          output_usd_per_million_tokens: "2",
        },
        revision: 1,
      },
    ]),
  );
  const view = (name: string) => {
    const { revision, ...model } = models.get(name)!;
    return { json: model, headers: { etag: `"m-${revision}"` } };
  };
  const lifecycle: { path: string; ifMatch?: string }[] = [];
  await page.route("**/ui/v1/models?**", (route) => {
    const archived =
      new URL(route.request().url()).searchParams.get("archived") === "true";
    return route.fulfill({
      json: {
        items: [...models.keys()]
          .filter((name) => Boolean(models.get(name)!.archived_at) === archived)
          .map((name) => view(name).json),
        next_cursor: null,
      },
    });
  });
  await page.route(
    /\/ui\/v1\/models\/[^/?]+(?:\/(?:archive|unarchive))?$/,
    (route) => {
      const parts = new URL(route.request().url()).pathname.split("/");
      const verb = ["archive", "unarchive"].includes(parts.at(-1)!)
        ? parts.pop()
        : undefined;
      const name = decodeURIComponent(parts.at(-1)!);
      const model = models.get(name);
      if (!model)
        return route.fulfill({
          status: 404,
          json: { code: "not_found", message: "model not found" },
        });
      if (verb && route.request().method() === "POST") {
        lifecycle.push({
          path: `${verb} ${name}`,
          ifMatch: route.request().headers()["if-match"],
        });
        const archived = verb === "archive";
        Object.assign(model, {
          archived_at: archived ? "2026-10-19T00:00:00Z" : null,
          paused: false,
          editable: !archived,
          can_archive: !archived,
          can_unarchive: archived,
          revision: model.revision + 1,
        });
        return route.fulfill({ status: 204, body: "" });
      }
      return route.fulfill(view(name));
    },
  );
  await page.route("**/ui/v1/flows?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            ...soloFlow,
            revision: 1,
            execution_tag: "openhands",
            model_aliases: ["1/m1"],
            prompt_template: "Work {{external_id}}",
            execution_parameters: {},
            default_image: null,
            source_ids: [],
            source_revisions: {},
            per_task_limit: null,
            flow_limit: null,
            created_at: "2026-10-18T00:00:00Z",
            updated_at: "2026-10-18T00:00:00Z",
          },
        ],
        next_cursor: null,
      },
    }),
  );
  return { lifecycle };
}

test("v0022.14 / web-ui: archive and unarchive models from Settings → Models", async ({
  page,
}) => {
  const { lifecycle } = await catalog(page);
  await page.goto(`${proxy.baseUrl}/?view=settings&section=models&team=1`);
  const current = page.locator("#models-results");
  const archived = page.locator("#archived-models-results");
  await expect(
    page.getByRole("heading", { name: "Current models" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Archived models" }),
  ).toBeVisible();
  await expect(archived).toContainText("No archived models");

  const row = (root: Locator, name: string) =>
    root
      .locator("tr:visible,article:visible")
      .filter({ has: page.getByRole("link", { name, exact: true }) });
  const command = async (name: string, action: string, root = current) => {
    await row(root, name)
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    return page
      .getByRole("menu", { name: `Actions for ${name}`, exact: true })
      .getByRole("menuitem", { name: action, exact: true });
  };
  // A sole-model flow blocks Archive and is named.
  const blocked = await command("m1", "Archive");
  await expect(blocked).toBeDisabled();
  await expect(
    page.getByRole("menu", { name: "Actions for m1", exact: true }),
  ).toContainText("only-m1");
  await page.keyboard.press("Escape");

  // Archive m2 with confirmation.
  await (await command("m2", "Archive")).click();
  const confirm = modelDialog(page, "Archive", "m2");
  await expect(confirm).toContainText("Already claimed tasks keep");
  await expect(confirm).toContainText("leaves every Flow model list");
  await confirm
    .getByRole("button", { name: "Archive model", exact: true })
    .click();
  await expect(confirm).toBeHidden();
  await expect(row(current, "m2")).toHaveCount(0);
  const archivedRow = row(archived, "m2");
  await expect(archivedRow).toContainText("Archived");
  await expect(
    archivedRow.getByRole("menuitem", { name: "Edit model" }),
  ).toHaveCount(0);

  // Unarchive with confirmation returns it as active.
  await (await command("m2", "Unarchive", archived)).click();
  const back = modelDialog(page, "Unarchive", "m2");
  await expect(back).toContainText("returns to Current models as Active");
  await expect(back).toContainText("not automatically added to any Flow");
  await back
    .getByRole("button", { name: "Unarchive model", exact: true })
    .click();
  await expect(back).toBeHidden();
  await expect(row(current, "m2")).toContainText("Active");
  await expect(archived).toContainText("No archived models");
  // Exactly one confirmed request per command, against the read revision;
  // the blocked m1 was never archived.
  expect(lifecycle).toEqual([
    { path: "archive m2", ifMatch: '"m-1"' },
    { path: "unarchive m2", ifMatch: '"m-2"' },
  ]);
});
