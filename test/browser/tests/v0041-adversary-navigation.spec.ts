import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { createFlowEntry } from "../fixtures/flow-editor";
import { createSourceEntry } from "../fixtures/source-wizard";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivors of task-sources-interface adversary-navigation.browser.spec.ts
// and navigation.browser.spec.ts (v0041 D15): routing is Web UI behavior;
// catalogs answer empty.
// Video of the tabs the browser opens would outlive the case (ffmpeg).
test.use({ actionTimeout: 10_000, video: "off" });

const teamID = 1;
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: teamID, team_name: "intake" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

// Survivor of task-sources-interface navigation.browser.spec.ts (v0041 D15),
// moved from v0041-navigation.spec.ts; it reads the same single-team proxy.
const navigationStep =
  "v0013.2 / standalone Flows and Sources, Parameters-first Settings";
const adversaryStep =
  "adversary navigation / real canonical destinations preserve click, Back and native new tab · Web UI unit";

test("v0013.2 / adversary navigation / standalone Flows and Sources, Parameters-first Settings; real canonical destinations preserve click, Back and native new tab · Web UI unit", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await test.step(navigationStep, async () => {
    // The Flows and Sources pages also read Source usage and Flow model
    // settings; this navigation check needs them empty, not failed.
    const empty = /\/ui\/v1\/(?:sources|flow-llm-settings)(?:\?.*)?$/;
    const emptyRoute = (route: import("@playwright/test").Route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { items: [], next_cursor: null } })
        : route.fallback();
    await page.route(empty, emptyRoute);
    try {
      await page.goto(proxy.baseUrl);
      await expect(page.locator("#team-selector")).toHaveValue("1");
      await expect(page.locator(".nav-links [data-view]")).toHaveText(
        ["Overview", "Flows", "Tasks", "Sources", "Settings"],
        { useInnerText: true },
      );
      await page.getByRole("link", { name: "Flows", exact: true }).click();
      await expect(page).toHaveURL(/view=flows/);
      await expect(createFlowEntry(page)).toBeVisible();
      await page.getByRole("link", { name: "Sources", exact: true }).click();
      await expect(page).toHaveURL(/view=sources/);
      await expect(createSourceEntry(page)).toBeVisible();
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(
        page.locator('[aria-label="Settings sections"] a'),
      ).toHaveText(["Parameters", "Models", "Executors", "Operator"]);
      await expect(
        page.locator('[aria-label="Settings sections"] [aria-current="page"]'),
      ).toHaveText("Parameters");
    } finally {
      await page.goto("about:blank");
      await page.unroute(empty, emptyRoute);
    }
  });
  await test.step(adversaryStep, async () => {
    // Every tab of this context reads empty catalogs, as a new team does.
    await context.route(
      /\/ui\/v1\/(?:sources|flows|flow-llm-settings|models|execution-tags)(?:\?.*)?$/,
      (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ json: { items: [], next_cursor: null } })
          : route.fallback(),
    );
    const writes: string[] = [];
    context.on("request", (request) => {
      if (
        !["GET", "HEAD"].includes(request.method()) &&
        new URL(request.url()).pathname.startsWith("/ui/")
      )
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    const expected = [
      ["Overview", "dashboard"],
      ["Flows", "flows"],
      ["Tasks", "history"],
      ["Sources", "sources"],
      ["Settings", "settings"],
    ];
    const observations: any[] = [];
    {
      await page.goto(`${proxy.baseUrl}/?view=dashboard&team=${teamID}`);
      await expect(page.locator("main h1")).toHaveText("Overview");
      const nav = page.getByRole("navigation", {
        name: "Main navigation",
        exact: true,
      });
      expect(
        (await nav.locator("[data-view]").allTextContents()).map((text) =>
          text.trim(),
        ),
      ).toEqual(expected.map(([label]) => label));
      for (const [label, view] of expected) {
        const item = nav.locator(`[data-view="${view}"]`);
        await expect(item).toHaveAccessibleName(label);
        const observed = await item.evaluate((node) => ({
          tag: node.tagName,
          href: node.getAttribute("href"),
          role: node.getAttribute("role"),
          text: node.textContent?.trim(),
        }));
        observations.push({ label, view, ...observed });
        expect
          .soft(observed.tag, `${label}: native anchor semantics`)
          .toBe("A");
        expect
          .soft(observed.href, `${label}: real link destination`)
          .not.toBeNull();
        if (observed.href) {
          const url = new URL(observed.href, proxy.baseUrl);
          expect.soft(url.origin).toBe(proxy.baseUrl);
          expect.soft(url.searchParams.get("view")).toBe(view);
          expect.soft(url.searchParams.get("team")).toBe(String(teamID));
          if (view === "settings")
            expect.soft(url.searchParams.get("section")).toBe("parameters");
        }
      }
      await nav.locator('[data-view="flows"]').click();
      await expect(page.locator("main h1")).toHaveText("Flows");
      expect(new URL(page.url()).searchParams.get("view")).toBe("flows");
      expect(new URL(page.url()).searchParams.get("team")).toBe(String(teamID));
      await page.goBack();
      await expect(page.locator("main h1")).toHaveText("Overview");
      expect(new URL(page.url()).searchParams.get("view")).toBe("dashboard");
      // v0034: Executors is reached through Settings, never primary navigation.
      await expect(nav.locator('[data-view="executors"]')).toHaveCount(0);
      await nav.locator('[data-view="settings"]').click();
      await expect(
        page.locator('[aria-label="Settings sections"] a'),
      ).toHaveText(["Parameters", "Models", "Executors", "Operator"]);
      await expect(
        page.locator('[aria-label="Settings sections"] [aria-current="page"]'),
      ).toHaveText("Parameters");
      await page
        .locator('[aria-label="Settings sections"]')
        .getByRole("link", { name: "Models", exact: true })
        .click();
      await expect(
        page.locator('[aria-label="Settings sections"] [aria-current="page"]'),
      ).toHaveText("Models");
      await nav.locator('[data-view="flows"]').click();
      await expect(page.locator("main h1")).toHaveText("Flows");
      await nav.locator('[data-view="settings"]').click();
      observations.push({
        settingsAfterModels: {
          href: await nav
            .locator('[data-view="settings"]')
            .getAttribute("href"),
          url: page.url(),
          activeSection: await page
            .locator('[aria-label="Settings sections"] [aria-current="page"]')
            .innerText(),
        },
      });
      await expect
        .soft(
          page.locator(
            '[aria-label="Settings sections"] [aria-current="page"]',
          ),
          "ordinary Settings click follows its Parameters destination after visiting Models",
        )
        .toHaveText("Parameters");
      expect
        .soft(
          new URL(page.url()).searchParams.get("section"),
          "ordinary Settings click URL matches real href section",
        )
        .toBe("parameters");
      await nav.locator('[data-view="dashboard"]').click();
      await expect(page.locator("main h1")).toHaveText("Overview");
      const flowLink = nav.locator('[data-view="flows"]');
      if (await flowLink.evaluate((node) => node.tagName === "A")) {
        const destination = await flowLink.getAttribute("href");
        await page.evaluate((href) => {
          const control = document.createElement("a");
          control.id = "adversary-native-control";
          control.href = href!;
          control.textContent = "Native browser calibration";
          control.style.cssText =
            "position:fixed;right:0;bottom:0;z-index:10000;background:white;padding:12px";
          document.body.append(control);
          (window as any).adversaryNavEvents = [];
          const record = (event: MouseEvent) => {
            if (
              (event.target as Element)?.closest(
                ".nav-links [data-view],#adversary-native-control",
              )
            )
              (window as any).adversaryNavEvents.push({
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                button: event.button,
                defaultPrevented: event.defaultPrevented,
                target: (event.target as Element)
                  .closest("a")
                  ?.getAttribute("href"),
              });
          };
          // A middle click dispatches auxclick, not click.
          document.addEventListener("click", record);
          document.addEventListener("auxclick", record);
        }, destination);
        await page.bringToFront();
        await expect
          .poll(() => page.evaluate(() => document.hasFocus()))
          .toBe(true);
        await page
          .locator("#adversary-native-control")
          .evaluate((node) => node.remove());
        // The middle click runs before the Ctrl probe: a Ctrl new tab can
        // leave the window unfocused and swallow the next middle click.
        await page.bringToFront();
        await expect
          .poll(() => page.evaluate(() => document.hasFocus()))
          .toBe(true);
        // Whether headless Chromium opens a tab for a middle click varies; the
        // Web UI's part is to leave the native default to the browser on the
        // link that keeps the team.
        // Tabs the browser opens, at any time, are closed so none outlives
        // the case.
        context.on("page", (extra) => void extra.close());
        await flowLink.click({ button: "middle" });
        const middleHref = await flowLink.getAttribute("href");
        expect(new URL(middleHref!, page.url()).searchParams.get("team")).toBe(
          String(teamID),
        );
        expect(
          await page.evaluate(() => (window as any).adversaryNavEvents.at(-1)),
        ).toMatchObject({ button: 1, defaultPrevented: false });
        expect(new URL(page.url()).searchParams.get("view")).toBe("dashboard");
        await page.bringToFront();
        await expect
          .poll(() => page.evaluate(() => document.hasFocus()))
          .toBe(true);
        const incidental = context
          .waitForEvent("page", { timeout: 1000 })
          .catch(() => null);
        await flowLink.click({ modifiers: ["Control"] });
        const incidentalTab = await incidental;
        await incidentalTab?.close();
        const modifiedEvents = await page.evaluate(
          () => (window as any).adversaryNavEvents,
        );
        observations.push({
          modifiedEvents,
          ctrlNewTabObserved: Boolean(incidentalTab),
          limit:
            "Ctrl new-tab window-focus intermittency is not a production RED or a shortcut guarantee; UI ctrl event must preserve native default.",
        });
        expect(modifiedEvents.at(-1)).toMatchObject({
          ctrlKey: true,
          defaultPrevented: false,
        });
        observations.push({
          modifiedClick:
            "UI left the native middle-click default on the same-team Flow link; original Overview unchanged",
        });
      } else
        observations.push({
          modifiedClick:
            "not attempted: runtime oracle found BUTTON with no href",
        });
      expect(writes).toEqual([]);
      test.info().annotations.push({
        type: "navigation-observations",
        description: JSON.stringify(observations),
      });
    }
  });
});
