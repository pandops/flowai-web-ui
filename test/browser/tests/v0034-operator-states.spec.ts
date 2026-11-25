import path from "node:path";
import { contrast } from "../fixtures/contrast";
import { test, expect } from "../fixtures/owned-test";
import { captureDesignState, designViewport } from "../fixtures/design-capture";
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

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.15 canonical Operator settings states ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout(180_000);
      for (const state of [
        "default",
        "first-use",
        "loading",
        "error",
        "saving",
        "saved",
        "stale",
        "invalid",
        "uncertain",
      ]) {
        const page = await context.newPage();
        const failures: unknown[] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reads = 0,
          writes = 0,
          revision = 1;
        let saved: string | null =
          state === "first-use" ? null : "Europe/Moscow";
        try {
          await page.setViewportSize(designViewport(width));
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          await page.route("**/ui/v1/operator/settings", async (route) => {
            if (route.request().method() === "PUT") {
              writes++;
              expect(route.request().headers()["if-match"]).toBe('"op-1"');
              expect(route.request().postDataJSON()).toEqual({
                time_zone: "America/New_York",
              });
              if (state === "saving") await held;
              if (state === "stale") {
                saved = "Asia/Kolkata";
                revision++;
                return route.fulfill({
                  status: 412,
                  json: { code: "stale_revision" },
                });
              }
              if (state === "uncertain") return route.abort("connectionreset");
              saved = "America/New_York";
              revision++;
            } else {
              reads++;
              if (state === "loading") await held;
              if (state === "error" || (state === "uncertain" && writes))
                return route.fulfill({
                  status: 503,
                  json: { code: "operator_settings_unavailable" },
                });
            }
            return route.fulfill({
              json: { time_zone: saved },
              headers: {
                etag: `"op-${revision}"`,
                "cache-control": "no-store",
              },
            });
          });
          await page.goto(
            `${proxy.baseUrl}?view=settings&section=operator&team=1`,
          );
          await expect.poll(() => reads).toBeGreaterThan(0);
          const form = page.locator("#operator-settings-form"),
            input = form.getByLabel("Time zone", { exact: true }),
            save = form.getByRole("button", { name: "Save", exact: true });
          await expect(form).toBeVisible();
          const badge = page.locator("[data-operator-setting-badge]");
          await expect(
            page.getByRole("heading", { name: "Time preview", exact: true }),
          ).toBeVisible();
          await expect(input).toHaveAttribute(
            "aria-describedby",
            /operator-time-zone-help/,
          );
          if (
            ["saving", "saved", "stale", "uncertain", "invalid"].includes(state)
          ) {
            await expect(input).toHaveValue("Europe/Moscow");
            await input.fill(
              state === "invalid" ? "Mars/Olympus" : "America/New_York",
            );
            await save.click();
          }
          const labels: Record<string, string> = {
            default: "Saved",
            "first-use": "Not saved",
            loading: "Loading",
            error: "Error",
            saving: "Saving",
            saved: "Saved",
            stale: "Reload required",
            invalid: "Invalid",
            uncertain: "Refresh required",
          };
          await expect(badge).toHaveText(labels[state]);
          expect((await badge.boundingBox())!.height).toBeCloseTo(28, 0);
          await expect(badge.locator("button,a,input,[tabindex]")).toHaveCount(
            0,
          );
          // Approved operator-settings.html: Save stays available while the
          // editor is ready; it is withheld only while unread, saving, or
          // awaiting a refresh after a stale or uncertain save.
          if (
            ["loading", "error", "saving", "stale", "uncertain"].includes(state)
          )
            await expect(save).toBeDisabled();
          else await expect(save).toBeEnabled();
          if (["loading", "error", "saving"].includes(state))
            await expect(input).toBeDisabled();
          if (state === "first-use") {
            await expect(input).toHaveValue("UTC");
            await expect(save).toBeEnabled();
          }
          if (state === "invalid") {
            await expect(input).toHaveAttribute("aria-invalid", "true");
            await expect(input).toBeFocused();
            await expect(input).toHaveAttribute(
              "aria-describedby",
              /operator-time-zone-error/,
            );
            await expect(form.getByRole("alert")).toContainText("valid IANA");
            const errorContrast = await contrast(form.getByRole("alert"));
            expect(
              errorContrast.ratio,
              JSON.stringify(errorContrast),
            ).toBeGreaterThanOrEqual(4.5);
            expect(writes).toBe(0);
          } else if (["saving", "saved", "stale", "uncertain"].includes(state))
            expect(writes).toBe(1);
          else expect(writes).toBe(0);
          const note = page.locator("#operator-state-note");
          if (state === "stale") {
            await expect(input).toHaveValue("America/New_York");
            await expect(note).toContainText("draft is retained");
          }
          if (state === "uncertain") {
            await expect.poll(() => reads).toBeGreaterThan(1);
            await expect(note).toContainText(
              "The previous save may have completed",
            );
          }
          if (state === "saved") {
            await expect(input).toHaveValue("America/New_York");
            await expect(note).toContainText(
              "Saved time zone: America/New_York",
            );
          }
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          // Capture resting commands, not the hover left by the Save click.
          await page.mouse.move(0, 0);
          await captureDesignState(
            page,
            test.info(),
            proxy.webUIImageID,
            `operator-settings.html-${state}-${theme}-${width}`,
          );
          if (state === "invalid") {
            const previousReads = reads;
            await form
              .getByRole("button", {
                name: "Reload saved setting",
                exact: true,
              })
              .click();
            await expect.poll(() => reads).toBeGreaterThan(previousReads);
            await expect(input).toHaveValue("Europe/Moscow");
            await expect(input).not.toHaveAttribute("aria-invalid", "true");
            await expect(form.getByRole("alert")).toBeEmpty();
            await expect(badge).toHaveText("Saved");
            expect(writes).toBe(0);
          }
        } catch (error) {
          failures.push(error);
        } finally {
          release();
          try {
            await page.unrouteAll({ behavior: "wait" });
          } catch (error) {
            failures.push(error);
          }
          try {
            await page.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length)
          throw new AggregateError(
            failures,
            `Operator ${state} verification or release failed`,
          );
      }
    });
