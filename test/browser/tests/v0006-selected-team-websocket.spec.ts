import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { test, expect } from "../fixtures/owned-test";
import { WebSocket, WebSocketServer } from "ws";
import { startMockedProxy } from "../fixtures/mocked_proxy";
import caseWait from "../fixtures/case-lifecycle";

test("v0006.10 replaces the selected-team live subscription and ignores late frames", async ({
  page,
}) => {
  // This case owns a Web UI container; its start and verified stop take
  // tens of seconds on a shared runtime, beyond the 30s suite default.
  test.setTimeout(120_000);
  const server = createServer((_, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ counts: {}, buckets: [] }));
  });
  const sockets = new Map<string, WebSocket>();
  const websocketServer = new WebSocketServer({ server });
  websocketServer.on("connection", (socket, request) => {
    sockets.set(request.url ?? "", socket);
    socket.on("close", () => {
      if (sockets.get(request.url ?? "") === socket)
        sockets.delete(request.url ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const upstream = `http://127.0.0.1:${address.port}`;
  const webEntry = path.resolve(__dirname, "../../../web/index.html");
  const proxy = await startMockedProxy(
    [
      { team_id: 1, team_name: "alpha" },
      { team_id: 2, team_name: "beta" },
    ],
    webEntry,
    upstream,
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/auth/v1/token", async (route) => {
    if (route.request().postDataJSON()?.team_id === 2)
      await caseWait.sleep(650);
    await route.continue();
  });

  // Record every socket the page opens, so the test can reach the prior
  // team's socket object after the switch.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const opened: WebSocket[] = [];
    (window as unknown as { __flowaiSockets: WebSocket[] }).__flowaiSockets =
      opened;
    window.WebSocket = class extends Native {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        opened.push(this);
      }
    };
  });

  try {
    await page.goto(proxy.baseUrl);
    const socketFor = (teamID: string) =>
      [...sockets.entries()].find(([url]) =>
        // An empty resume cursor leaves no query on the upstream request.
        new RegExp(`^/ui/v1/teams/${teamID}/stream(?:\\?|$)`).test(url),
      )?.[1];
    await expect.poll(() => socketFor("1")?.readyState).toBe(1);
    const alpha = socketFor("1")!;
    // The prior team's upstream keeps publishing after the switch: when the
    // browser has left the alpha subscription and its connection ends, the
    // upstream still sends a late alpha frame on it, before it notices the
    // end itself (this listener runs before the WebSocket library's own).
    const lateFrames: string[] = [];
    const alphaTransport = (alpha as unknown as { _socket: Socket })._socket;
    alphaTransport.prependListener("end", () => {
      if (alpha.readyState !== WebSocket.OPEN) return;
      alpha.send(JSON.stringify({ team_id: 1, text: "late-alpha" }));
      lateFrames.push("late-alpha");
    });

    await page.getByLabel("Team", { exact: true }).selectOption("2");
    const betaProtocol = `flowai.bearer.${Buffer.from("working-2").toString("base64url")}`;
    await expect
      .poll(
        () =>
          proxy.upgradeHeaders.filter(
            (headers) => headers["sec-websocket-protocol"] === betaProtocol,
          ).length,
      )
      .toBe(1);
    expect(proxy.upgradeHeaders).toHaveLength(2);
    await expect.poll(() => socketFor("2")?.readyState).toBe(1);
    await expect.poll(() => alpha.readyState).toBe(3);
    // The late frame really left the prior team's upstream.
    expect(lateFrames).toEqual(["late-alpha"]);
    await expect(page.getByTestId("live-frame")).toHaveAttribute(
      "data-stream-state",
      "connected",
    );

    const beta = socketFor("2");
    expect(beta).toBeDefined();
    expect(beta!.readyState).toBe(1);
    // The late alpha frame left before this beta frame; it never renders,
    // now or after a further settling interval.
    beta!.send(JSON.stringify({ team_id: 2, text: "current-beta" }));
    await expect(page.getByTestId("live-frame")).toContainText("current-beta");
    await expect(page.getByTestId("live-frame")).not.toContainText(
      "late-alpha",
    );
    await caseWait.sleep(500);
    await expect(page.getByTestId("live-frame")).toContainText("current-beta");
    await expect(page.getByTestId("live-frame")).not.toContainText(
      "late-alpha",
    );
    // The switch closes the prior socket, so the browser and the proxy drop
    // its later frames before the page sees them. A frame that still reaches
    // the prior socket's handler (a browser that delivers while closing) must
    // be ignored by the page itself: deliver one to that handler directly.
    const delivered = await page.evaluate(() => {
      const prior = (
        window as unknown as { __flowaiSockets: WebSocket[] }
      ).__flowaiSockets.find((socket) =>
        socket.url.includes("/ui/v1/teams/1/stream"),
      );
      if (!prior?.onmessage) return false;
      prior.onmessage(
        new MessageEvent("message", {
          data: JSON.stringify({
            team_id: 1,
            text: "late-alpha-handler",
          }),
        }),
      );
      return true;
    });
    expect(delivered, "the prior team's socket handler was reached").toBe(true);
    await expect(page.getByTestId("live-frame")).toContainText("current-beta");
    await expect(page.getByTestId("live-frame")).not.toContainText(
      "late-alpha-handler",
    );
    expect(pageErrors).toEqual([]);
  } finally {
    await proxy.close();
    for (const socket of websocketServer.clients) socket.terminate();
    server.close();
    server.closeAllConnections();
  }
});
