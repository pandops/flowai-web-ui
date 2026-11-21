import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

async function uncertainCreateRoutes(page: Page) {
  await page.route("**/ui/v1/models?**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/ui/v1/models", (route) =>
    route.fulfill({ status: 503, json: { code: "model_gateway_unavailable" } }),
  );
}

// A fresh document per call: no form draft or notice survives.
async function uncertainCreate(page: Page) {
  await page.goto(`${proxy.baseUrl}?view=settings&section=models&team=1`);
  await page.getByRole("button", { name: "Create model", exact: true }).click();
  const form = page.locator("#model-form");
  await form.locator('[name="name"]').fill("uncertain-model");
  await form.locator('[name="provider_model"]').fill("fixture-model");
  await form.locator('[name="input_price"]').fill("1");
  await form.locator('[name="output_price"]').fill("2");
  await form.getByRole("button", { name: "Save model", exact: true }).click();
  await expect(form.locator(".validation")).toContainText("may have completed");
  return form;
}

test("v0034.10 Model create reload: rejected reload clears key; pending reload admits one read", async ({
  page,
}) => {
  await uncertainCreateRoutes(page);
  // Each step holds the canonical read with its own promise and outcome.
  let outcome: "abort" | "not-found" = "abort",
    captured = false,
    reads = 0,
    held = Promise.resolve();
  await page.route("**/ui/v1/models/uncertain-model", async (route) => {
    captured = true;
    reads++;
    const current = outcome;
    await held;
    if (current === "abort") await route.abort("failed");
    else await route.fulfill({ status: 404, json: { code: "not_found" } });
  });
  const releases: (() => void)[] = [];
  const hold = () => {
    held = new Promise<void>((resolve) => releases.push(resolve));
    return releases[releases.length - 1];
  };
  try {
    await test.step("v0034.10 rejected Model reload clears a key entered during the request", async () => {
      outcome = "abort";
      captured = false;
      const release = hold();
      const form = await uncertainCreate(page);
      await form.getByRole("button", { name: "Reload", exact: true }).click();
      await expect.poll(() => captured).toBe(true);
      await form
        .locator('[name="api_key"]')
        .fill("synthetic-pending-reload-key");
      release();
      await expect(form.locator(".validation")).toContainText(
        /reload.*(failed|unavailable|could not)|could not.*reload/i,
      );
      await expect(form.locator('[name="api_key"]')).toHaveValue("");
      await expect(form.locator('[name="input_price"]')).toHaveValue("1");
      await expect(form.locator('[name="output_price"]')).toHaveValue("2");
      await expect(
        form.getByRole("button", { name: "Save model", exact: true }),
      ).toBeDisabled();
      await expect(
        form.getByRole("button", { name: "Reload", exact: true }),
      ).toBeEnabled();
    });
    await test.step("v0034.10 pending canonical Model reload admits one read", async () => {
      outcome = "not-found";
      reads = 0;
      const release = hold();
      const form = await uncertainCreate(page);
      const reload = form.getByRole("button", { name: "Reload", exact: true });
      await reload.click();
      await expect.poll(() => reads).toBe(1);
      await expect(reload).toBeDisabled();
      // A second ordinary activation cannot dispatch another canonical read.
      await reload.evaluate((button: HTMLButtonElement) => button.click());
      expect(reads).toBe(1);
      release();
      await expect(form.locator(".validation")).toContainText(
        "No saved model has that name",
      );
      await expect(reload).toBeEnabled();
      expect(reads).toBe(1);
    });
  } finally {
    for (const release of releases) release();
  }
});
