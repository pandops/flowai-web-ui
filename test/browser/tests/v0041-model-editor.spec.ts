import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture } from "../fixtures/v0034-flow";

// Survivor of task-sources-interface v0034-model-editor.browser.spec.ts
// (v0041 D15): read-only Model identity, Save blocked until both prices are
// set, and one PUT with If-Match and pricing only. Registry persistence and
// the unchanged Flow revision are State Registry tests.
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

for (const theme of ["dark", "light"] as const)
  test(`v0034.7 Model identity is read-only and standalone edit requires both prices ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("flowai.theme", value),
      theme,
    );
    await flowFixture(page);
    let model: Record<string, unknown> = {
      name: "model",
      model_alias: "1/model",
      provider: "openai",
      provider_model: "x",
      api_base: "https://models.example.test/v1",
      created_by: "team",
      model_id: 8033,
      created_at: "2026-10-18T00:00:00Z",
      updated_at: "2026-10-18T00:00:00Z",
      unfinished_task_count: 0,
      can_archive: false,
      can_unarchive: false,
      archive_blocking_flows: [],
      editable: true,
      paused: false,
      archived_at: null,
      credential_configured: true,
      pricing_status: "not_configured",
      pricing: null,
    };
    let etag = '"model-rev-1"';
    await page.route("**/ui/v1/models?**", (route) =>
      route.fulfill({
        json: {
          items:
            new URL(route.request().url()).searchParams.get("archived") ===
            "true"
              ? []
              : [model],
          next_cursor: null,
        },
      }),
    );
    await page.route("**/ui/v1/models/model", (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        model = { ...model, ...body, pricing_status: "configured" };
        etag = '"model-rev-2"';
      }
      return route.fulfill({ json: model, headers: { etag } });
    });
    const writes: {
      method: string;
      path: string;
      body: any;
      etag?: string;
    }[] = [];
    page.on("request", (request) => {
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
        new URL(request.url()).pathname.startsWith("/ui/v1/")
      )
        writes.push({
          method: request.method(),
          path: new URL(request.url()).pathname,
          body: request.postData() ? request.postDataJSON() : null,
          etag: request.headers()["if-match"],
        });
    });
    await page.goto(`${proxy.baseUrl}/?view=settings&section=models&team=1`);
    await page
      .getByRole("link", { name: "model", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Model detail", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("main .detail-grid div", {
        has: page.locator("dt", { hasText: /^Name$/ }),
      }),
    ).toHaveText("Namemodel");
    await expect(
      page.locator("main input,main select,main textarea"),
    ).toHaveCount(0);
    expect(writes).toEqual([]);
    await page.getByRole("link", { name: "Edit model", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Edit model · model", exact: true }),
    ).toBeVisible();
    const form = page.locator("#standalone-model-form");
    const input = form.getByLabel("Input price (USD per 1M tokens)", {
      exact: true,
    });
    const output = form.getByLabel("Output price (USD per 1M tokens)", {
      exact: true,
    });
    await expect(input).toHaveValue("");
    await expect(output).toHaveValue("");
    const credential = form.getByLabel("Replacement API key (write-only)", {
      exact: true,
    });
    await expect(credential).toHaveValue("");
    await credential.fill("synthetic-invalid-price-clear-canary");
    await page.getByRole("button", { name: "Save model", exact: true }).click();
    expect(writes).toEqual([]);
    await expect(credential).toHaveValue("");
    await expect(input).toBeFocused();
    await input.fill("0.000001");
    await output.fill("7.125");
    await page.getByRole("button", { name: "Save model", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].path).toBe("/ui/v1/models/model");
    expect(writes[0].method).toBe("PUT");
    expect(writes[0].etag).toBe('"model-rev-1"');
    expect(writes[0].body.pricing).toEqual({
      input_usd_per_million_tokens: "0.000001",
      output_usd_per_million_tokens: "7.125",
    });
    expect(writes[0].body).not.toHaveProperty("api_key");
    expect(writes[0].body).not.toHaveProperty("model_aliases");
    expect(JSON.stringify(writes)).not.toContain(
      "synthetic-invalid-price-clear-canary",
    );
  });
