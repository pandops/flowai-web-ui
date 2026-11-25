import { captureDesignState } from "../fixtures/design-capture";
import { modelDialog } from "../fixtures/approved-dialogs";
import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture } from "../fixtures/v0034-flow";
import type { Page, Route } from "@playwright/test";

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

type Operation = "Pause" | "Archive" | "Unarchive";
const modelPath = (name: string) => `/ui/v1/models/${name}`;
async function lifecycleFixture(
  page: Page,
  operation: Operation,
  initiallyPaused = false,
) {
  const { writes } = await flowFixture(page);
  const models = new Map(
    ["first", "second"].map((name) => [
      name,
      {
        name,
        model_alias: `1/${name}`,
        provider: "openai",
        provider_model: "fixture",
        created_by: "team",
        paused: operation === "Unarchive" || initiallyPaused,
        archived_at: operation === "Unarchive" ? "2026-10-18T00:00:00Z" : null,
        editable: operation !== "Unarchive",
        can_archive: operation !== "Unarchive",
        can_unarchive: operation === "Unarchive",
        archive_blocking_flows: [],
        credential_configured: true,
        pricing_status: "configured",
        pricing: {
          input_usd_per_million_tokens: "1",
          output_usd_per_million_tokens: "2",
        },
      },
    ]),
  );
  await page.route("**/ui/v1/flows?**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/ui/v1/models?**", (route) =>
    route.fulfill({
      json: {
        items: [...models.values()].filter(
          (model) =>
            Boolean(model.archived_at) ===
            (new URL(route.request().url()).searchParams.get("archived") ===
              "true"),
        ),
        next_cursor: null,
      },
    }),
  );
  for (const name of models.keys()) {
    await page.route(`**${modelPath(name)}`, (route) => {
      if (route.request().method() === "PUT")
        models.set(name, {
          ...models.get(name)!,
          ...route.request().postDataJSON(),
        });
      return route.fulfill({
        json: models.get(name),
        headers: { etag: '"1"' },
      });
    });
    for (const verb of ["archive", "unarchive"])
      await page.route(`**${modelPath(name)}/${verb}`, (route) => {
        const archived = verb === "archive";
        models.set(name, {
          ...models.get(name)!,
          archived_at: archived ? "2026-10-19T00:00:00Z" : null,
          paused: archived,
          editable: !archived,
          can_unarchive: archived,
          can_archive: !archived,
        });
        return route.fulfill({ status: 204 });
      });
  }
  const open = async (name: string) => {
    const root = page.locator(
      operation === "Unarchive"
        ? "#archived-models-results"
        : "#models-results",
    );
    await root
      .locator("tr:visible,article:visible")
      .filter({ has: page.getByRole("link", { name, exact: true }) })
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await page
      .getByRole("menu", { name: `Actions for ${name}`, exact: true })
      .getByRole("menuitem", { name: operation, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `${operation} model ${name}`,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  await page.goto(`${proxy.baseUrl}?view=settings&section=models&team=1`);
  return { writes, models, open };
}

for (const operation of ["Pause", "Archive", "Unarchive"] as const) {
  test(`v0034.10 Model ${operation} confirmation is single-submit while its canonical read is held`, async ({
    page,
  }) => {
    const { writes, models, open } = await lifecycleFixture(page, operation);
    let captured = false,
      release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${modelPath("first")}`, async (route) => {
      if (route.request().method() === "GET") {
        captured = true;
        await held;
      }
      await route.fallback();
    });
    try {
      const dialog = await open("first"),
        submit = dialog.getByRole("button", {
          name: `${operation} model`,
          exact: true,
        });
      await submit.click();
      await expect.poll(() => captured).toBe(true);
      await expect(submit).toBeDisabled();
      expect(writes).toEqual([]);
      await dialog.locator("form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
        (form as HTMLFormElement).requestSubmit();
      });
      release();
      await expect(dialog).not.toBeVisible();
      expect(writes.map((write) => write.path)).toEqual([
        operation === "Pause"
          ? modelPath("first")
          : `${modelPath("first")}/${operation.toLowerCase()}`,
      ]);
    } finally {
      release();
    }
  });

  test(`v0034.10 late Model ${operation} error and success cannot change a reopened confirmation`, async ({
    page,
  }) => {
    const { writes, models, open } = await lifecycleFixture(page, operation);
    let result: "success" | "error" = "error",
      captured = false,
      held = Promise.resolve();
    const releases: (() => void)[] = [];
    const hold = () => {
      held = new Promise<void>((resolve) => releases.push(resolve));
      return releases[releases.length - 1];
    };
    const mutationPath =
      operation === "Pause"
        ? modelPath("first")
        : `${modelPath("first")}/${operation.toLowerCase()}`;
    await page.route(`**${mutationPath}`, async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: models.get("first"),
          headers: { etag: '"1"' },
        });
      captured = true;
      const current = result;
      await held;
      if (current === "success") await route.fallback();
      else
        await route.fulfill({
          status: 412,
          json: { code: "revision_mismatch" },
        });
    });
    try {
      // The error step runs first: its 412 leaves the models unchanged, so the
      // success step starts from the same initial state on a fresh document.
      for (const current of ["error", "success"] as const)
        await test.step(`v0034.10 late Model ${operation} ${current} cannot change a reopened confirmation`, async () => {
          if (current === "success") {
            await page.reload();
            writes.length = 0;
          }
          result = current;
          captured = false;
          const release = hold();
          const old = await open("first");
          await old
            .getByRole("button", { name: `${operation} model`, exact: true })
            .click();
          await expect.poll(() => captured).toBe(true);
          await old
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          const newer = await open("second");
          const response = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === mutationPath &&
              r.request().method() !== "GET",
          );
          release();
          const completed = await response;
          expect(completed.status()).toBe(
            current === "error" ? 412 : operation === "Pause" ? 200 : 204,
          );
          // A 204 has no body; observe its headers and the app's next frames.
          if (completed.status() !== 204) await completed.body();
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          await expect(newer).toBeVisible();
          await expect(newer.getByRole("alert")).toHaveText("");
          await expect(
            newer.getByRole("button", {
              name: `${operation} model`,
              exact: true,
            }),
          ).toBeEnabled();
          expect(writes.map((write) => write.path)).toEqual([mutationPath]);
        });
    } finally {
      for (const release of releases) release();
    }
  });

  test(`v0034.10 Model ${operation} read and write network failures keep recoverable confirmation`, async ({
    page,
  }) => {
    const { open, writes } = await lifecycleFixture(page, operation);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mutationPath =
      operation === "Pause"
        ? modelPath("first")
        : `${modelPath("first")}/${operation.toLowerCase()}`;
    // Disarmed (null) while a step loads its document, as when each original
    // test registered its route after the first navigation.
    let failureAt: "read" | "write" | null = "read";
    const fail = async (route: Route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (failureAt === "read" && pathname === modelPath("first"))
        return route.abort("failed");
      if (
        failureAt === "write" &&
        pathname === mutationPath &&
        route.request().method() !== "GET"
      )
        return route.abort("failed");
      await route.fallback();
    };
    await page.route(`**${modelPath("first")}`, fail);
    if (mutationPath !== modelPath("first"))
      await page.route(`**${mutationPath}`, fail);
    for (const current of ["read", "write"] as const)
      await test.step(`v0034.10 Model ${operation} ${current} network failure keeps recoverable confirmation`, async () => {
        if (current === "write") {
          failureAt = null;
          await page.reload();
          writes.length = 0;
          errors.length = 0;
        }
        failureAt = current;
        const dialog = await open("first");
        await dialog
          .getByRole("button", { name: `${operation} model`, exact: true })
          .click();
        await expect(dialog.getByRole("alert")).toContainText(
          /could not|unavailable|refresh|uncertain/i,
        );
        if (current === "write")
          await expect(dialog.getByRole("alert")).toContainText(
            /may have|uncertain|refresh/i,
          );
        expect(errors).toEqual([]);
        await expect(dialog).toBeVisible();
        expect(writes.map((write) => write.path)).toEqual(
          current === "read" ? [] : [mutationPath],
        );
        // Cancelling an uncertain outcome never dispatches a retry or claims rollback.
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        expect(writes.map((write) => write.path)).toEqual(
          current === "read" ? [] : [mutationPath],
        );
      });
  });
}

test("v0034.10 Resume is single-submit during its canonical read", async ({
  page,
}) => {
  const { writes } = await lifecycleFixture(page, "Pause", true);
  let release!: () => void,
    captured = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${modelPath("first")}`, async (route) => {
    if (route.request().method() === "GET") {
      captured = true;
      await held;
    }
    await route.fallback();
  });
  await page
    .getByRole("button", { name: "Actions for first", exact: true })
    .click();
  const menu = page.getByRole("menu", {
    name: "Actions for first",
    exact: true,
  });
  const menuID = await menu.getAttribute("id");
  // Keep observing the actual command after its popover closes on activation.
  const resume = page.locator(`#${menuID} [data-resume-model="first"]`);
  try {
    await resume.click();
    // The approved Resume confirmation sends nothing until it is confirmed.
    const dialog = modelDialog(page, "Resume", "first");
    await expect(dialog).toBeVisible();
    expect(captured).toBe(false);
    expect(writes).toEqual([]);
    const confirm = dialog.getByRole("button", {
      name: "Resume model",
      exact: true,
    });
    await confirm.click();
    await expect.poll(() => captured).toBe(true);
    await expect(confirm).toBeDisabled();
    // Programmatic submission checks the handler guard, not only the button.
    await dialog.locator("form").evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    release();
    await expect(dialog).not.toBeVisible();
    await expect(
      page
        .locator("#models-results")
        .locator("tr:visible,article:visible")
        .filter({ has: page.getByRole("link", { name: "first", exact: true }) })
        .locator(".badge")
        .filter({ hasText: /^Active$/ }),
    ).toBeVisible();
    expect(writes.map((write) => write.path)).toEqual([modelPath("first")]);
  } finally {
    release();
  }
});

test("v0034.10 uncertain Resume requires refresh, claims no confirmation and keeps recovery after repaint", async ({
  page,
}) => {
  const { writes } = await lifecycleFixture(page, "Pause", true);
  // The Resume write aborts, so the models never change between steps.
  await page.route(`**${modelPath("first")}`, async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    await route.abort("failed");
  });
  const resume = async () => {
    await page
      .getByRole("button", { name: "Actions for first", exact: true })
      .click();
    await page
      .getByRole("menu", { name: "Actions for first", exact: true })
      .getByRole("menuitem", { name: "Resume", exact: true })
      .click();
    // Resume is confirmed in its own dialog.
    await modelDialog(page, "Resume", "first")
      .getByRole("button", { name: "Resume model", exact: true })
      .click();
  };
  await test.step("v0034.10 Resume uncertain write requires refresh and claims no confirmation", async () => {
    await resume();
    const alert = page
      .locator("#models-results, dialog[open]")
      .getByRole("alert");
    await expect(alert).toContainText(/uncertain|may have/i);
    await expect(alert).toContainText(/refresh|reload/i);
    await expect(alert).not.toContainText(/confirmation|close and reopen/i);
    expect(writes.map((write) => write.path)).toEqual([modelPath("first")]);
    await page
      .getByRole("button", { name: "Actions for first", exact: true })
      .click();
    await expect(
      page
        .getByRole("menu", { name: "Actions for first", exact: true })
        .getByRole("menuitem", { name: "Resume", exact: true }),
    ).toBeDisabled();
    expect(writes.map((write) => write.path)).toEqual([modelPath("first")]);
  });
  await test.step("v0034.10 uncertain Resume retains reachable recovery after catalog repaint", async () => {
    await page.reload();
    writes.length = 0;
    await resume();
    await expect(
      page.locator("#models-results, dialog[open]").getByRole("alert"),
    ).toContainText(/uncertain/i);
    await page
      .locator("[data-model-filters]")
      .getByLabel("Rows per page")
      .selectOption("25");
    await expect(
      page.locator("#models-results, dialog[open]").getByRole("alert"),
    ).toContainText(/uncertain/i);
    await expect(
      page.getByRole("button", { name: "Refresh model first", exact: true }),
    ).toBeVisible();
    expect(writes.map((write) => write.path)).toEqual([modelPath("first")]);
  });
});

for (const operation of ["Pause", "Archive", "Unarchive"] as const)
  test(`v0034.10 ${operation} uncertain completion requires explicit canonical refresh without retry`, async ({
    page,
  }) => {
    const { writes, models, open } = await lifecycleFixture(page, operation);
    let canonicalReads = 0;
    const mutationPath =
      operation === "Pause"
        ? modelPath("first")
        : `${modelPath("first")}/${operation.toLowerCase()}`;
    await page.route(`**${modelPath("first")}`, async (route) => {
      if (route.request().method() === "GET") {
        canonicalReads++;
        return route.fallback();
      }
      return route.fulfill({
        status: 503,
        json: { code: "model_gateway_unavailable" },
      });
    });
    if (operation !== "Pause")
      await page.route(`**${mutationPath}`, (route) =>
        route.fulfill({
          status: 503,
          json: { code: "model_gateway_unavailable" },
        }),
      );
    const dialog = await open("first");
    await dialog
      .getByRole("button", { name: `${operation} model`, exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      /uncertain|may have/i,
    );
    await expect(dialog.getByRole("alert")).not.toContainText(
      /nothing (was )?changed/i,
    );
    await expect(
      dialog.getByRole("button", { name: `${operation} model`, exact: true }),
    ).toBeDisabled();
    const refresh = dialog.getByRole("button", {
      name: "Refresh model",
      exact: true,
    });
    await expect(refresh).toBeVisible();
    expect(canonicalReads).toBe(1);
    expect(writes.map((write) => write.path)).toEqual([mutationPath]);
    // The original operation completed upstream despite the unconfirmed response.
    const model = models.get("first")!;
    models.set("first", {
      ...model,
      paused: operation !== "Unarchive",
      archived_at: operation === "Archive" ? "2026-10-19T00:00:00Z" : null,
      editable: operation !== "Archive",
      can_archive: operation !== "Archive",
      can_unarchive: operation === "Archive",
    });
    await refresh.click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => canonicalReads).toBe(2);
    expect(writes.map((write) => write.path)).toEqual([mutationPath]);
    const root = page.locator(
      operation === "Archive" ? "#archived-models-results" : "#models-results",
    );
    const record = root
      .locator("tr:visible,article:visible")
      .filter({ has: page.getByRole("link", { name: "first", exact: true }) });
    await expect(record).toBeVisible();
    await expect(record.locator(".badge")).toHaveText(
      operation === "Archive"
        ? "Archived"
        : operation === "Pause"
          ? "Paused"
          : "Active",
    );
  });

test("v0034.10 a sole-model archive refusal names the blocking Flow", async ({
  page,
}) => {
  const { writes, models, open } = await lifecycleFixture(page, "Archive");
  const dialog = await open("first");
  // A Flow selected only this model after the catalog was read.
  models.set("first", {
    ...models.get("first")!,
    can_archive: false,
    archive_blocking_flows: [
      { flow_id: 7018, name: "Intake routing" },
    ] as never[],
  });
  await page.route(`**${modelPath("first")}/archive`, (route) =>
    route.fulfill({ status: 409, json: { code: "model_last_in_flow" } }),
  );
  await dialog
    .getByRole("button", { name: "Archive model", exact: true })
    .click();
  const box = dialog.locator(".state-box.warn");
  await expect(box).toContainText("Operation conflict");
  await expect(box).toContainText(
    "Archive is blocked because Intake routing has this as its only model. Add another model to that Flow first.",
  );
  await expect(
    box.getByRole("link", { name: "Intake routing", exact: true }),
  ).toBeVisible();
  expect(writes.map((write) => write.path)).toEqual([
    `${modelPath("first")}/archive`,
  ]);
});

test("v0034.10 malformed canonical refresh cannot clear uncertain confirmation", async ({
  page,
}) => {
  const { open, writes } = await lifecycleFixture(page, "Pause");
  let refreshing = false;
  await page.route(`**${modelPath("first")}`, async (route) => {
    if (route.request().method() !== "GET")
      return route.fulfill({
        status: 503,
        json: { code: "model_gateway_unavailable" },
      });
    if (refreshing) return route.fulfill({ json: {} });
    await route.fallback();
  });
  const dialog = await open("first");
  await dialog
    .getByRole("button", { name: "Pause model", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(/uncertain/i);
  refreshing = true;
  await dialog
    .getByRole("button", { name: "Refresh model", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(/latest|refresh/i);
  await expect(
    dialog.getByRole("button", { name: "Pause model", exact: true }),
  ).toBeDisabled();
  expect(writes.map((write) => write.path)).toEqual([modelPath("first")]);
});

test("v0034.10 old canonical refresh cannot enable a newer busy confirmation", async ({
  page,
}) => {
  const { open, models } = await lifecycleFixture(page, "Pause");
  const held = new Map<
    string,
    { reads: number; release: () => void; wait: Promise<void> }
  >();
  for (const name of ["first", "second"]) {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    held.set(name, { reads: 0, release, wait });
    await page.route(`**${modelPath(name)}`, async (route) => {
      if (route.request().method() !== "GET")
        return route.fulfill({
          status: 503,
          json: { code: "model_gateway_unavailable" },
        });
      const gate = held.get(name)!;
      if (++gate.reads === 2) await gate.wait;
      await route.fulfill({ json: models.get(name), headers: { etag: '"1"' } });
    });
  }
  try {
    const first = await open("first");
    await first
      .getByRole("button", { name: "Pause model", exact: true })
      .click();
    await expect(first.getByRole("alert")).toContainText(/uncertain/i);
    await first
      .getByRole("button", { name: "Refresh model", exact: true })
      .click();
    await expect.poll(() => held.get("first")!.reads).toBe(2);
    await first.getByRole("button", { name: "Cancel", exact: true }).click();
    const second = await open("second");
    await second
      .getByRole("button", { name: "Pause model", exact: true })
      .click();
    await expect(second.getByRole("alert")).toContainText(/uncertain/i);
    const refresh = second.getByRole("button", {
      name: "Refresh model",
      exact: true,
    });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect.poll(() => held.get("second")!.reads).toBe(2);
    await expect(refresh).toBeDisabled();
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === modelPath("first") &&
        r.request().method() === "GET",
    );
    held.get("first")!.release();
    await (await response).body();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(second).toBeVisible();
    await expect(refresh).toBeDisabled();
  } finally {
    for (const gate of held.values()) gate.release();
  }
});

test("v0034.10 uncertain Resume is immediately refreshable without catalog repaint", async ({
  page,
}) => {
  const { writes, models } = await lifecycleFixture(page, "Pause", true);
  let reads = 0;
  await page.route(`**${modelPath("first")}`, async (route) => {
    if (route.request().method() === "GET") {
      reads++;
      return route.fallback();
    }
    return route.fulfill({
      status: 503,
      json: { code: "model_gateway_unavailable" },
    });
  });
  await page
    .getByRole("button", { name: "Actions for first", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "Actions for first", exact: true })
    .getByRole("menuitem", { name: "Resume", exact: true })
    .click();
  // The approved design confirms Resume in its own dialog.
  await modelDialog(page, "Resume", "first")
    .getByRole("button", { name: "Resume model", exact: true })
    .click();
  await expect(
    page.locator("#models-results, dialog[open]").getByRole("alert"),
  ).toContainText(/uncertain/i);
  const refresh = page.getByRole("button", {
    name: "Refresh model first",
    exact: true,
  });
  await expect(refresh).toBeEnabled();
  expect(reads).toBe(1);
  models.set("first", { ...models.get("first")!, paused: false });
  await refresh.click();
  await expect.poll(() => reads).toBe(2);
  const first = page
    .locator("#models-results")
    .locator("tr:visible,article:visible")
    .filter({ has: page.getByRole("link", { name: "first", exact: true }) });
  await expect(first.locator(".badge")).toHaveText("Active");
  await expect(refresh).toHaveCount(0);
  expect(writes.map((write) => write.path)).toEqual([modelPath("first")]);
});

test("v0034.10 independent uncertain Resume recoveries survive another model refresh", async ({
  page,
}) => {
  const { writes, models } = await lifecycleFixture(page, "Pause", true);
  for (const name of ["first", "second"])
    await page.route(`**${modelPath(name)}`, async (route) => {
      if (route.request().method() === "GET") return route.fallback();
      return route.fulfill({
        status: 503,
        json: { code: "model_gateway_unavailable" },
      });
    });
  for (const name of ["first", "second"]) {
    await page
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await page
      .getByRole("menu", { name: `Actions for ${name}`, exact: true })
      .getByRole("menuitem", { name: "Resume", exact: true })
      .click();
    // The approved design confirms Resume in its own dialog.
    await modelDialog(page, "Resume", name)
      .getByRole("button", { name: "Resume model", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `Refresh model ${name}`, exact: true }),
    ).toBeEnabled();
  }
  await expect(
    page.locator("#models-results, dialog[open]").getByRole("alert"),
  ).toHaveCount(2);
  models.set("first", { ...models.get("first")!, paused: false });
  await page
    .getByRole("button", { name: "Refresh model first", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh model first", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh model second", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator("#models-results, dialog[open]").getByRole("alert"),
  ).toContainText(/second.*uncertain/i);
  await page
    .getByRole("button", { name: "Actions for second", exact: true })
    .click();
  await expect(
    page
      .getByRole("menu", { name: "Actions for second", exact: true })
      .getByRole("menuitem", { name: "Resume", exact: true }),
  ).toBeDisabled();
  expect(writes.map((write) => write.path)).toEqual([
    modelPath("first"),
    modelPath("second"),
  ]);
});

test("v0034.10 unreadable Resume point read retains feedback and permits an explicit new attempt", async ({
  page,
}) => {
  const { writes } = await lifecycleFixture(page, "Pause", true);
  let reads = 0;
  await page.route(`**${modelPath("first")}`, async (route) => {
    if (route.request().method() === "GET" && ++reads === 1)
      return route.abort("failed");
    await route.fallback();
  });
  const resume = async () => {
    await page
      .getByRole("button", { name: "Actions for first", exact: true })
      .click();
    const command = page
      .getByRole("menu", { name: "Actions for first", exact: true })
      .getByRole("menuitem", { name: "Resume", exact: true });
    await expect(command).toBeEnabled();
    await command.click();
    await modelDialog(page, "Resume", "first")
      .getByRole("button", { name: "Resume model", exact: true })
      .click();
  };
  await resume();
  await expect(
    page.locator("#models-results, dialog[open]").getByRole("alert"),
  ).toContainText(/could not be read|connection/i);
  expect(writes).toEqual([]);
  expect(reads).toBe(1);
  await page
    .getByRole("searchbox", { name: "Search models", exact: true })
    .fill("first");
  await expect(
    page
      .locator("#models-results")
      .getByRole("link", { name: "second", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("#models-results, dialog[open]").getByRole("alert"),
  ).toContainText(/could not be read|connection/i);
  await resume();
  await expect(
    page
      .locator("#models-results")
      .locator("tr:visible,article:visible")
      .filter({ has: page.getByRole("link", { name: "first", exact: true }) })
      .locator(".badge")
      .filter({ hasText: /^Active$/ }),
  ).toBeVisible();
  expect(reads).toBe(2);
  expect(writes.map((write) => write.path)).toEqual([modelPath("first")]);
  await expect(
    page.locator("#models-results, dialog[open]").getByRole("alert"),
  ).toHaveCount(0);
});

test("v0034.10 Model lifecycle rejects malformed canonical point reads (wrong identity, missing ETag, empty body) before mutation", async ({
  page,
}) => {
  const { writes, models, open } = await lifecycleFixture(page, "Pause");
  // Disarmed (null) while a step loads its document, as when each original
  // test registered its route after the first navigation.
  let malformed: "wrong identity" | "missing ETag" | "empty body" | null = null;
  await page.route(`**${modelPath("first")}`, async (route) => {
    if (route.request().method() !== "GET" || malformed === null)
      return route.fallback();
    await route.fulfill({
      json:
        malformed === "empty body"
          ? null
          : {
              ...models.get("first"),
              name: malformed === "wrong identity" ? "second" : "first",
            },
      headers: malformed === "missing ETag" ? {} : { etag: '"point-read"' },
    });
  });
  for (const current of [
    "wrong identity",
    "missing ETag",
    "empty body",
  ] as const)
    await test.step(`v0034.10 Model lifecycle rejects ${current} canonical point reads before mutation`, async () => {
      if (current !== "wrong identity") {
        malformed = null;
        await page.reload();
      }
      malformed = current;
      const dialog = await open("first");
      await dialog
        .getByRole("button", { name: "Pause model", exact: true })
        .click();
      await expect(dialog.locator(".validation")).toContainText(
        /latest model could not be confirmed/i,
      );
      await expect(
        dialog.getByRole("button", { name: "Pause model", exact: true }),
      ).toBeEnabled();
      await expect(dialog.locator(".validation")).not.toContainText(
        /uncertain|may have completed/i,
      );
      expect(writes).toEqual([]);
    });
});

// Retained screenshots complement behavior assertions; they are not a full visual verdict.
test.afterEach(async ({ page }, info) => {
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    `final-${info.title}`,
  );
});

for (const theme of ["dark", "light"] as const)
  for (const [width, height] of [
    [390, 844],
    [820, 1180],
    [1440, 900],
  ])
    test(`v0034.12 complete Models catalog presentation states ${theme} ${width}`, async ({
      browser,
    }, info) => {
      test.setTimeout(240_000);
      const failures: unknown[] = [];
      for (const state of [
        "default",
        "edit",
        "add-model",
        "pause-model",
        "resume-model",
        "archive-model",
        "archive-blocked",
        "unarchive-model",
        "conflict-409",
        "revision-412",
        "model-503",
        "busy",
        "empty-current",
        "empty-archived",
        "loading",
        "error",
        "edit-model",
        "pricing-missing",
        "pricing-zero",
        "invalid-pricing",
        "pricing-unsupported",
      ]) {
        const context = await browser.newContext({
            viewport: { width, height },
          }),
          page = await context.newPage();
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached = 0;
        try {
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          const operation =
            state === "unarchive-model"
              ? "Unarchive"
              : state === "archive-model"
                ? "Archive"
                : "Pause";
          const { models, writes, open } = await lifecycleFixture(
            page,
            operation,
            state === "resume-model",
          );
          const first = models.get("first")!;
          // The approved catalog sample lists one archived model below the
          // current ones.
          if (state !== "unarchive-model")
            models.set("retired", {
              ...models.get("second")!,
              name: "retired",
              model_alias: "1/retired",
              archived_at: "2026-10-19T00:00:00Z",
              paused: true,
              editable: false,
              can_archive: false,
              can_unarchive: true,
            });
          if (state === "archive-blocked")
            Object.assign(first, {
              can_archive: false,
              archive_blocking_flows: [
                {
                  flow_id: 8009,
                  name: "Order flow",
                },
              ],
            });
          if (state.startsWith("pricing-"))
            Object.assign(first, {
              pricing_status:
                state === "pricing-missing"
                  ? "not_configured"
                  : state === "pricing-unsupported"
                    ? "unsupported"
                    : "configured",
              pricing:
                state === "pricing-zero"
                  ? {
                      input_usd_per_million_tokens: "0",
                      output_usd_per_million_tokens: "0",
                    }
                  : null,
            });
          // The approved empty states (ui-mockups/settings-models.html
          // empty-current and empty-archived) show one bare No data panel for
          // a catalog without any model.
          if (["empty-current", "empty-archived"].includes(state))
            models.clear();
          if (["loading", "error"].includes(state))
            await page.route("**/ui/v1/models?**", async (route) => {
              reached++;
              if (state === "loading") await held;
              await route.fulfill({
                status: 503,
                json: { code: "model_gateway_unavailable" },
              });
            });
          await page.reload();
          if (["loading", "error"].includes(state)) {
            await expect.poll(() => reached).toBeGreaterThan(0);
            await expect(page.locator("#models-results")).toContainText(
              state === "loading"
                ? /loading/i
                : /unavailable|could not|failed/i,
            );
          } else if (["edit", "edit-model"].includes(state)) {
            await page.goto(`${proxy.baseUrl}?view=model-edit&team=1&id=first`);
            await expect(page.locator("#standalone-model-form")).toBeVisible();
          } else if (["add-model", "invalid-pricing"].includes(state)) {
            await page
              .getByRole("button", { name: "Create model", exact: true })
              .click();
            const form = page.locator("#model-form");
            await expect(form).toBeVisible();
            if (state === "invalid-pricing") {
              await form.locator('[name="name"]').fill("new-model");
              await form.locator('[name="provider_model"]').fill("fixture");
              await form.locator('[name="input_price"]').fill("invalid");
              await form.locator('[name="output_price"]').fill("1");
              await form
                .getByRole("button", { name: "Save model", exact: true })
                .click();
              await expect(form.locator(".validation")).not.toBeEmpty();
              expect(writes).toEqual([]);
              // Capture the rest state, not the hover tone of Save.
              await page.mouse.move(0, 0);
            }
          } else if (
            [
              "pause-model",
              "archive-model",
              "unarchive-model",
              "conflict-409",
              "revision-412",
              "model-503",
              "busy",
            ].includes(state)
          ) {
            if (
              ["conflict-409", "revision-412", "model-503", "busy"].includes(
                state,
              )
            )
              await page.route(`**${modelPath("first")}`, async (route) => {
                if (route.request().method() === "GET") return route.fallback();
                reached++;
                if (state === "busy") await held;
                await route.fulfill({
                  status:
                    state === "conflict-409"
                      ? 409
                      : state === "revision-412"
                        ? 412
                        : 503,
                  json: {
                    code:
                      state === "revision-412"
                        ? "stale_revision"
                        : "model_gateway_unavailable",
                    message: "Refresh the canonical model before retrying",
                  },
                });
              });
            const dialog = await open("first");
            if (
              ["conflict-409", "revision-412", "model-503", "busy"].includes(
                state,
              )
            ) {
              await dialog
                .getByRole("button", {
                  name: `${operation} model`,
                  exact: true,
                })
                .click();
              await expect.poll(() => reached).toBe(1);
              if (state === "busy")
                await expect(
                  dialog.getByRole("button", {
                    name: `${operation} model`,
                    exact: true,
                  }),
                ).toBeDisabled();
              else await expect(dialog.locator("[role=alert]")).not.toBeEmpty();
            }
          } else if (["resume-model", "archive-blocked"].includes(state)) {
            await page
              .locator("#models-results")
              .getByRole("button", { name: "Actions for first", exact: true })
              .click();
            const action = page.getByRole("menu").getByRole("menuitem", {
              name: state === "resume-model" ? "Resume" : "Archive",
              exact: true,
            });
            if (state === "archive-blocked") {
              await expect(action).toBeDisabled();
              await page.keyboard.press("Escape");
              await expect(page.getByRole("menu")).toHaveCount(0);
            } else {
              await expect(action).toBeEnabled();
              await action.click();
              await expect(modelDialog(page, "Resume", "first")).toBeVisible();
            }
          } else {
            const root = page.locator("#models-results");
            if (state.startsWith("empty-")) {
              await expect(root).toContainText(/no current models/i);
              await expect(
                root.getByRole("heading", { name: "No data", exact: true }),
              ).toBeVisible();
              await expect(
                page.getByRole("button", { name: "Create model", exact: true }),
              ).toBeVisible();
            } else
              await expect(
                root.getByRole("link", { name: "first", exact: true }).first(),
              ).toBeVisible();
          }
          await captureDesignState(
            page,
            info,
            proxy.webUIImageID,
            `settings-models.html-${state}-${theme}-${width}`,
          );
        } catch (error) {
          failures.push(error);
          await info.attach(`models-${state}-failure`, {
            body: String(error),
            contentType: "text/plain",
          });
        } finally {
          release();
          await context.close();
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Models presentation batch");
    });
