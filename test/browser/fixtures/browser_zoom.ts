import type { Browser, BrowserContext, BrowserServer } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { ownCaseResource } from "./case-lifecycle";

// Cross-suite fixtures must use the invoking runner's Playwright instance.
const fixtureRequire = createRequire(__filename);
const { chromium }: typeof import("@playwright/test") = fixtureRequire(
  fixtureRequire.resolve("@playwright/test", {
    paths: [process.cwd(), __dirname],
  }),
);

// Persistent context + Chromium channel follow Playwright's extension guide:
// https://playwright.dev/docs/chrome-extensions
// Native zoom is independently read back with chrome.tabs.getZoom:
// https://developer.chrome.com/docs/extensions/reference/api/tabs#method-getZoom
export async function startBrowserZoom(
  options: {
    naturalVisibility?: boolean;
    tracePath?: string;
  } = {},
) {
  let directory: string | undefined, context: BrowserContext | undefined;
  let attached: Browser | undefined, server: BrowserServer | undefined;
  const cleanup = async () => {
    const errors: unknown[] = [];
    const closeTimer = server
      ? setTimeout(
          () => void server?.kill().catch((error) => errors.push(error)),
          10_000,
        )
      : undefined;
    try {
      if (attached && context && options.tracePath) {
        try {
          await context.tracing.stop({ path: options.tracePath });
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        if (attached) await attached.close();
        else await context?.close();
      } catch (error) {
        errors.push(error);
      }
      attached = undefined;
      context = undefined;
      try {
        await server?.close();
      } catch (error) {
        errors.push(error);
      }
      server = undefined;
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Owned native browser cleanup failed");
  };
  const controller = new AbortController();
  const { signal } = controller;
  const close = ownCaseResource(async () => {
    controller.abort();
    await startup.catch(() => undefined);
    await cleanup();
  });
  const startup = (async () => {
    try {
      const native = process.env.FLOWAI_BROWSER_NATIVE_TMP;
      if (!native)
        throw new Error("Native browser ownership namespace is missing");
      directory = await mkdtemp(path.join(native, "zoom-"));
      signal.throwIfAborted();
      const browserTmp = path.join(directory, "native");
      await mkdir(browserTmp);
      signal.throwIfAborted();
      const extension = path.resolve(__dirname, "browser-zoom");
      if (options.naturalVisibility) {
        if (!options.tracePath)
          throw new Error("Native visibility requires a retained trace path");
        // Use the installed launcher's complete defaults and process lifecycle.
        // Its nonpersistent connection ignores default-context pages; the CDP
        // connection below owns those pages without focus/visibility emulation.
        server = await chromium.launchServer({
          channel: "chromium",
          headless: true,
          timeout: 15_000,
          handleSIGINT: false,
          handleSIGTERM: false,
          env: {
            ...process.env,
            TMPDIR: browserTmp,
            TMP: browserTmp,
            TEMP: browserTmp,
          },
          args: [
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
            "--window-size=1440,900",
          ],
        });
        signal.throwIfAborted();
        const profileArgument = server
          .process()
          .spawnargs.find((arg) => arg.startsWith("--user-data-dir="));
        if (!profileArgument)
          throw new Error("Owned launcher profile is missing");
        const profile = profileArgument.slice("--user-data-dir=".length);
        if (path.dirname(profile) !== os.tmpdir())
          throw new Error("Owned launcher profile escaped the run namespace");
        let port = "";
        for (let attempt = 0; attempt < 200; attempt++) {
          signal.throwIfAborted();
          try {
            port = (
              await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
            ).split("\n")[0];
            if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
              throw new Error("Invalid owned Chrome debugging port");
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await delay(25, undefined, { signal });
        }
        if (!port)
          throw new Error("Owned native Chrome debugging deadline exceeded");
        attached = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          noDefaults: true,
          artifactsDir: path.join(directory, "browser-artifacts"),
          isLocal: true,
          timeout: 10_000,
        });
        context = attached.contexts()[0];
        if (!context)
          throw new Error("Owned native Chrome has no default context");
      } else {
        context = await chromium.launchPersistentContext(
          path.join(directory, "profile"),
          {
            channel: "chromium",
            headless: true,
            viewport: null,
            timezoneId: "UTC",
            timeout: 15_000,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              TMPDIR: browserTmp,
              TMP: browserTmp,
              TEMP: browserTmp,
            },
            args: [
              `--disable-extensions-except=${extension}`,
              `--load-extension=${extension}`,
              "--window-size=1440,900",
            ],
          },
        );
      }
      signal.throwIfAborted();
      const initialPage = context.pages()[0] ?? await context.newPage();
      const session = await context.newCDPSession(initialPage);
      try {
        const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
        const { width, height } = await initialPage.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        await session.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            width: bounds.width! + 1440 - width,
            height: bounds.height! + 900 - height,
          },
        });
        await initialPage.waitForFunction(() => innerWidth === 1440 && innerHeight === 900);
      } finally {
        await session.detach();
      }
      context.setDefaultTimeout(10_000);
      if (options.naturalVisibility) {
        if (!options.tracePath)
          throw new Error("Native visibility requires a retained trace path");
        await context.tracing.start({
          screenshots: false,
          snapshots: true,
          sources: true,
        });
      }
      const isZoomWorker = (worker: { url(): string }) =>
        worker.url().startsWith("chrome-extension://") &&
        worker.url().endsWith("/worker.js");
      const worker =
        context.serviceWorkers().find(isZoomWorker) ??
        (await context.waitForEvent("serviceworker", {
          predicate: isZoomWorker,
          timeout: 10_000,
        }));
      signal.throwIfAborted();
      return {
        context,
        close,
        async inspectOwnedTabs() {
          return worker.evaluate(async () => ({
            worker: globalThis.location.href,
            permissions: (globalThis as any).chrome.runtime.getManifest()
              .permissions,
            tabs: (await (globalThis as any).chrome.tabs.query({})).map(
              (tab: any) => ({
                id: tab.id,
                url: tab.url,
                pendingUrl: tab.pendingUrl,
                active: tab.active,
              }),
            ),
          }));
        },
        async switchToBlankTab(url: string) {
          const transition = await worker.evaluate(async (url) => {
            const tabs = (globalThis as any).chrome.tabs;
            const targets = (await tabs.query({})).filter(
              (tab: { url: string }) => tab.url === url,
            );
            if (targets.length !== 1)
              throw new Error("Visibility target is not one owned tab");
            const from = targets[0];
            if (!from.active)
              throw new Error("Visibility target must start as the active tab");
            const blank = await tabs.create({
              windowId: from.windowId,
              url: "about:blank",
              active: true,
            });
            return {
              from: from.id,
              window: from.windowId,
              blank: blank.id,
              fromActive: (await tabs.get(from.id)).active as boolean,
              blankActive: blank.active as boolean,
            };
          }, url);
          return {
            ...transition,
            async restore() {
              return worker.evaluate(async (transition) => {
                const tabs = (globalThis as any).chrome.tabs;
                const blank = await tabs.get(transition.blank);
                if (
                  blank.windowId !== transition.window ||
                  blank.url !== "about:blank"
                )
                  throw new Error(
                    "Owned visibility tab changed identity: " +
                      JSON.stringify({
                        sameWindow: blank.windowId === transition.window,
                        url:
                          blank.url === "about:blank"
                            ? "about:blank"
                            : blank.url
                              ? "other"
                              : "unset",
                        pendingUrl:
                          blank.pendingUrl === "about:blank"
                            ? "about:blank"
                            : blank.pendingUrl
                              ? "other"
                              : "unset",
                        status: blank.status,
                      }),
                  );
                await tabs.update(transition.from, { active: true });
                await tabs.remove(transition.blank);
                return (await tabs.get(transition.from)).active as boolean;
              }, transition);
            },
          };
        },
        async setZoom(url: string, factor: number) {
          return worker.evaluate(
            async ({ url, factor }) => {
              const tabs = (globalThis as any).chrome.tabs;
              const matches = (await tabs.query({})).filter(
                (tab: { url: string }) => tab.url === url,
              );
              if (matches.length !== 1)
                throw new Error("Zoom target is not one owned tab");
              await tabs.setZoom(matches[0].id, factor);
              return tabs.getZoom(matches[0].id) as Promise<number>;
            },
            { url, factor },
          );
        },
      };
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Browser zoom startup and cleanup failed",
        );
      }
      throw error;
    }
  })();
  return startup;
}
