import path from "node:path";
import type { Page, WebSocket } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { MATRIX, usePresentation } from "../fixtures/v0048-ui";
import { startFakeGateway, type FakeGateway } from "../fixtures/fake_gateway";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";

// mocked-proxy (v0048): the browser's only backend is the mocked proxy, which
// forwards the allowed /ui/v1 routes to the test-local fake Gateway surface.
// The four mocked-proxy capability files share this setup (AGENTS.md: tests
// sharing setup are one test), so they live here, under the runner's tests/.
test.use({ actionTimeout: 10_000 });
const webEntry = path.resolve(__dirname, "../../../web/index.html");
let fake: FakeGateway;
let proxy: MockedProxy;
test.beforeEach(async () => {
  fake = await startFakeGateway(1, [2]);
  proxy = await startMockedProxy(
    [
      { team_id: 1, team_name: "alpha" },
      { team_id: 2, team_name: "beta" },
    ],
    webEntry,
    fake.origin,
  );
});
test.afterEach(async () => {
  await proxy?.close();
  await fake?.close();
});

function browserTraffic(page: Page) {
  const origins = new Set<string>();
  const sockets: WebSocket[] = [];
  // A navigation unloads the previous document with its sockets, which may
  // never report close when they were still connecting.
  const unloaded = new Set<WebSocket>();
  // A document request (not a history push) replaces the document.
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      sockets.forEach((socket) => unloaded.add(socket));
  });
  page.on("request", (request) => origins.add(new URL(request.url()).origin));
  page.on("websocket", (socket) => {
    origins.add(new URL(socket.url()).origin.replace(/^ws/, "http"));
    sockets.push(socket);
  });
  const closed = (socket: WebSocket) =>
    socket.isClosed() || unloaded.has(socket);
  return { origins, sockets, closed };
}

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 mocked proxy forwards UI traffic only to the fake Gateway surface · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    test.setTimeout(120_000);
    const traffic = browserTraffic(page);

    await test.step("Browser uses the mocked proxy", async () => {
      await page.goto(`${proxy.baseUrl}/?view=history&team=1`);
      await expect(
        page.getByRole("link", { name: "alpha-1", exact: true }),
      ).toBeVisible();
      await page.goto(`${proxy.baseUrl}/?view=task&team=1&id=3`);
      await expect(
        page.getByRole("heading", { name: "Execution timeline", exact: true }),
      ).toBeVisible();
      await expect.poll(() => traffic.sockets.length).toBeGreaterThan(0);
      expect([...traffic.origins]).toEqual([new URL(proxy.baseUrl).origin]);
    });

    await test.step("Integration route reaches only the fake Gateway surface", async () => {
      const reads = fake.requests.filter((request) =>
        request.path.startsWith("/ui/v1/teams/1/tasks"),
      );
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((request) => request.team === 1)).toBe(true);
      // Every forwarded /ui/v1 request reached the fake; the proxy answered
      // only auth and presentation routes itself.
      const forwarded = proxy.requests.filter(
        (item) =>
          item.startsWith("/ui/v1/") &&
          !item.startsWith("/ui/v1/auth/") &&
          !item.startsWith("/ui/v1/operator/") &&
          !item.includes("/stream"),
      );
      const answered = new Set(fake.requests.map((request) => request.path));
      for (const item of forwarded) expect(answered, item).toContain(item);
      await expect(page.locator("main")).toContainText("external-3");
    });

    await test.step("Operator switches teams", async () => {
      await page.goto(`${proxy.baseUrl}/?view=history&team=1`);
      await expect
        .poll(() => traffic.sockets.filter((s) => !traffic.closed(s)).length)
        .toBeGreaterThan(0);
      const before = fake.requests.length;
      const streamsBefore = fake.streamQueries.length;
      const oldSockets = traffic.sockets.filter(
        (socket) => !traffic.closed(socket),
      );
      await page.getByLabel("Team", { exact: true }).selectOption("2");
      await expect(page).toHaveURL(/[?&]team=2(&|$)/);
      await expect
        .poll(() => oldSockets.every((socket) => traffic.closed(socket)))
        .toBe(true);
      await expect.poll(() => fake.streamQueries.length).toBeGreaterThan(0);
      // The fake sends a pushed frame only to streams it has already
      // accepted, and a first connect replays nothing. The browser reports
      // its socket before the proxy's upstream upgrade reaches the fake, so
      // wait until the fake accepts the new team's stream before pushing.
      await expect
        .poll(() => fake.streamQueries.length)
        .toBeGreaterThan(streamsBefore);
      const later = fake.requests
        .slice(before)
        .filter((request) => request.path.startsWith("/ui/v1/teams/"));
      expect(later.length).toBeGreaterThan(0);
      for (const request of later) {
        expect(request.team).toBe(2);
        expect(request.path).toMatch(/^\/ui\/v1\/teams\/2\//);
      }
      const open = () =>
        traffic.sockets.filter((socket) => !traffic.closed(socket));
      await expect.poll(() => open().length).toBe(1);
      const current = open();
      const received: string[] = [];
      current[0].on("framereceived", (frame) =>
        received.push(String(frame.payload)),
      );
      fake.push(1, {
        frame_type: "task_event",
        team_id: 1,
        task_id: 1,
        data: { marker: "team-1-frame" },
      });
      fake.push(2, {
        frame_type: "task_event",
        team_id: 2,
        task_id: 1,
        data: { marker: "team-2-frame" },
      });
      await expect.poll(() => received.join("\n")).toContain("team-2-frame");
      expect(received.join("\n")).not.toContain("team-1-frame");
    });
  });

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 mocked proxy is non-authoritative and excludes admin and ingestion · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    await page.goto(`${proxy.baseUrl}/?view=settings&team=1`);
    const call = (method: string, url: string, body?: unknown) =>
      page.evaluate(
        async ({ method, url, body }) => {
          const response = await fetch(url, {
            method,
            headers: {
              authorization: "Bearer working-1",
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const text = await response.text();
          return {
            status: response.status,
            body: text ? JSON.parse(text) : null,
          };
        },
        { method, url, body },
      );

    await test.step("UI mutates launch parameters in integration mode", async () => {
      const created = await call("POST", "/ui/v1/teams/1/launch-parameters", {
        scope: "flow",
        flow_id: 2,
        name: "Review parameters",
        env: { REVIEW: "on" },
      });
      expect(created.status).toBe(201);
      const id = created.body.environment_id as number;
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(
        fake.launchParameters.find((item) => item.environment_id === id),
      ).toMatchObject({
        name: "Review parameters",
        env: { REVIEW: "on" },
      });
      expect(
        (
          await call("PUT", `/ui/v1/teams/1/launch-parameters/${id}`, {
            env: { REVIEW: "off" },
          })
        ).status,
      ).toBe(200);
      expect(
        fake.launchParameters.find((item) => item.environment_id === id)?.env,
      ).toEqual({ REVIEW: "off" });
      expect(
        (
          await call("PUT", "/ui/v1/teams/1/launch-parameters/1/secrets/1", {
            value: "rotated",
          })
        ).status,
      ).toBe(200);
      expect(fake.launchParameters[0].secrets[0].current_version).toBe(3);
      expect(
        (await call("DELETE", `/ui/v1/teams/1/launch-parameters/${id}`)).status,
      ).toBe(204);
      expect(
        fake.launchParameters.some((item) => item.environment_id === id),
      ).toBe(false);
    });

    await test.step("Browser attempts an excluded route", async () => {
      const before = fake.requests.length;
      for (const url of [
        "/admin/v1/teams",
        "/v1/teams/1/tasks",
        "/webhook/1/listener-alpha/task",
      ]) {
        const reply = await call("POST", url, { team_id: 1 });
        expect(reply.status, url).toBe(404);
        expect(reply.body?.code, url).toBe("route_excluded");
      }
      expect(fake.requests.length).toBe(before);
    });
  });
