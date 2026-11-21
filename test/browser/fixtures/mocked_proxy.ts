import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { sharedWebUIContainer } from "./web_ui_container";

const proxySockets = new Set<WebSocket>();
function trackSocket(socket: WebSocket, local: Set<WebSocket>) {
  // After answering a close frame the peer already sent, ws arms a 30s timer
  // waiting for the peer's TCP close; the peer initiated the close, so drop
  // the timer and let ws end the socket once its close frame is written.
  const close = socket.close.bind(socket);
  socket.close = ((...args: Parameters<WebSocket["close"]>) => {
    close(...args);
    const state = socket as unknown as {
      _closeFrameReceived?: boolean;
      _closeTimer?: ReturnType<typeof setTimeout>;
    };
    if (state._closeFrameReceived && state._closeTimer) {
      clearTimeout(state._closeTimer);
      state._closeTimer = undefined;
    }
  }) as WebSocket["close"];
  local.add(socket);
  proxySockets.add(socket);
  socket.once("close", () => {
    local.delete(socket);
    proxySockets.delete(socket);
  });
}
export async function closeMockedProxySockets(): Promise<void> {
  await Promise.all(
    [...proxySockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          socket.once("close", resolve);
          socket.terminate();
        }),
    ),
  );
}

export type TeamOption = Readonly<{
  team_id: number;
  team_name: string;
  archived_at?: string | null;
}>;

export type MockedProxy = Readonly<{
  baseUrl: string;
  requests: readonly string[];
  upgradeHeaders: readonly import("node:http").IncomingHttpHeaders[];
  webUIImageID?: string;
  close: () => Promise<void>;
}>;

export async function startMockedProxy(
  teams: readonly TeamOption[],
  webEntry?: string,
  gatewayOrigin?: string,
): Promise<MockedProxy> {
  validateTeams(teams);
  const webUI = webEntry ? await sharedWebUIContainer() : undefined;
  const requests: string[] = [];
  const upgradeHeaders: import("node:http").IncomingHttpHeaders[] = [];
  const sockets = new Set<WebSocket>();
  const connections = new Set<Socket>();
  let closing: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    if (
      request.method === "GET" &&
      new URL(path, "http://mocked-proxy").pathname === "/" &&
      webUI
    ) {
      const upstream = await fetch(`${webUI.baseUrl}/`);
      response.setHeader(
        "content-type",
        upstream.headers.get("content-type") ?? "text/html; charset=utf-8",
      );
      response
        .writeHead(upstream.status)
        .end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    response.setHeader("content-type", "application/json; charset=utf-8");

    // Administration and task ingestion are never reachable from the
    // browser: the proxy answers them itself and forwards nothing.
    if (isExcludedRoute(path)) {
      response.writeHead(404).end(
        JSON.stringify({
          code: "route_excluded",
          message: `route is not exposed to the browser: ${path}`,
        }),
      );
      return;
    }

    if (request.method === "GET" && path === "/health") {
      response.writeHead(200).end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && path === "/auth/v1/teams") {
      response.writeHead(200).end(JSON.stringify({ teams }));
      return;
    }
    if (request.method === "GET" && path === "/ui/v1/teams") {
      response.writeHead(200).end(
        JSON.stringify({
          items: teams.map(({ team_id, team_name }) => ({
            team_id,
            team_name,
          })),
        }),
      );
      return;
    }
    if (request.method === "GET" && path === "/ui/v1/operator/settings") {
      response.setHeader("etag", '"op-0"');
      response.setHeader("cache-control", "no-store");
      response.writeHead(200).end(JSON.stringify({ time_zone: null }));
      return;
    }
    if (request.method === "POST" && path === "/auth/v1/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as {
        team_id?: unknown;
      };
      if (!teams.some((team) => team.team_id === input.team_id)) {
        response
          .writeHead(403)
          .end(JSON.stringify({ code: "team_not_accessible" }));
        return;
      }
      response.writeHead(200).end(
        JSON.stringify({
          access_token: `working-${input.team_id}`,
          token_type: "Bearer",
          expires_in: 300,
        }),
      );
      return;
    }
    // Presentation-only unset preference; durable operator behavior is exercised
    // through the real Gateway fixture, not this proxy.
    if (request.method === "GET" && path === "/ui/v1/operator/settings") {
      const teamID = Number(
        request.headers.authorization?.replace(/^Bearer working-/, ""),
      );
      if (!teams.some((team) => team.team_id === teamID)) {
        response.writeHead(401).end(JSON.stringify({ code: "unauthorized" }));
        return;
      }
      response
        .writeHead(200, { ETag: '\"op-0\"', "Cache-Control": "no-store" })
        .end(JSON.stringify({ time_zone: null }));
      return;
    }
    if (gatewayOrigin && isAllowedUIRoute(path)) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      // The fake Gateway verifies the working bearer itself, exactly as the
      // real Gateway does; the proxy forwards it unchanged and adds no
      // identity header of its own.
      const headers = forwardHeaders(request.headers);
      if (request.headers.authorization)
        headers.set("authorization", request.headers.authorization);
      const upstream = await fetch(new URL(path, gatewayOrigin), {
        method: request.method,
        headers,
        body: body.length > 0 ? body : undefined,
      });
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) =>
        response.setHeader(name, value),
      );
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const dashboard = path.match(/^\/ui\/v1\/teams\/([^/]+)\/dashboard/);
    if (request.method === "GET" && dashboard) {
      response.writeHead(200).end(
        JSON.stringify({
          team_id: Number(dashboard[1]),
          period: "week",
          counts: {
            queued: 0,
            created: 0,
            pending: 0,
            running: 0,
            finished: 0,
            failed: 0,
            cancelled: 0,
          },
          buckets: [],
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      /^\/ui\/v1\/teams\/[^/]+\/launch-parameters(?:\?.*)?$/.test(path)
    ) {
      response
        .writeHead(200)
        .end(JSON.stringify({ items: [], next_cursor: null }));
      return;
    }
    if (request.method === "GET" && /^\/ui\/v1\/flows(?:\?.*)?$/.test(path)) {
      response
        .writeHead(200)
        .end(JSON.stringify({ items: [], next_cursor: null }));
      return;
    }
    if (
      request.method === "POST" &&
      /^\/ui\/v1\/teams\/[^/]+\/launch-parameters$/.test(path)
    ) {
      response.writeHead(201).end(JSON.stringify({ status: "created" }));
      return;
    }
    response.writeHead(404).end(
      JSON.stringify({
        code: "route_unknown",
        message: `route is unavailable: ${path}`,
      }),
    );
  });

  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const path = request.url ?? "/";
    if (!/^\/ui\/v1\/teams\/[^/]+\/stream(?:\?.*)?$/.test(path)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    requests.push(path);
    upgradeHeaders.push(request.headers);
    if (!gatewayOrigin) {
      websocketServer.handleUpgrade(request, socket, head, (browser) => {
        trackSocket(browser, sockets);
      });
      return;
    }
    const target = new URL(path, gatewayOrigin);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    // The bearer travels in the browser's subprotocol; the fake Gateway
    // verifies it like any other request.
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const upstream = new WebSocket(target, protocols);
    trackSocket(upstream, sockets);
    socket.once("end", () => {
      upstream.terminate();
      socket.destroy();
    });
    socket.once("close", () => upstream.terminate());
    socket.on("error", () => upstream.terminate());
    const failUpgrade = () => {
      if (!socket.destroyed)
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    };
    upstream.once("error", failUpgrade);
    upstream.once("open", () => {
      upstream.off("error", failUpgrade);
      if (socket.destroyed) {
        upstream.terminate();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (browser) => {
        trackSocket(browser, sockets);
        browser.on("message", (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN)
            upstream.send(data, { binary });
        });
        upstream.on("message", (data, binary) => {
          if (browser.readyState === WebSocket.OPEN)
            browser.send(data, { binary });
        });
        browser.on("close", () => upstream.terminate());
        upstream.on("close", () => browser.terminate());
        browser.on("error", () => upstream.terminate());
        upstream.on("error", () => browser.terminate());
      });
    });
  });

  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    upgradeHeaders,
    webUIImageID: webUI?.imageID,
    close: () =>
      (closing ??= (async () => {
        const releases = [
          close(server),
          new Promise<void>((resolve, reject) =>
            websocketServer.close((error) =>
              error ? reject(error) : resolve(),
            ),
          ),
          ...[...sockets].map(
            (socket) =>
              new Promise<void>((resolve) => {
                if (socket.readyState === WebSocket.CLOSED) return resolve();
                socket.once("close", () => resolve());
                socket.terminate();
              }),
          ),
          ...[...connections].map(
            (socket) =>
              new Promise<void>((resolve) => {
                socket.once("close", () => resolve());
                socket.destroy();
              }),
          ),
        ];
        const outcomes = await Promise.allSettled(releases);
        const errors = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : [],
        );
        if (errors.length)
          throw new AggregateError(errors, "Mock proxy teardown failed");
      })()),
  };
}

export const VALID_TEAM_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function validateTeams(teams: readonly TeamOption[]): void {
  const seen = new Set<number>();
  for (const [index, team] of teams.entries()) {
    if (!team || !Number.isSafeInteger(team.team_id) || team.team_id < 1) {
      throw new Error(`teams[${index}].team_id must be a positive integer`);
    }
    if (typeof team.team_name !== "string" || team.team_name.trim() === "") {
      throw new Error(`teams[${index}].team_name must be a non-empty string`);
    }
    // team-registry's create rule (v0050): a lowercase letter, then
    // lowercase letters and digits in hyphen-joined groups, 10 at most.
    if (!VALID_TEAM_NAME.test(team.team_name) || team.team_name.length > 10) {
      throw new Error(
        `teams[${index}].team_name must match ${VALID_TEAM_NAME} and have at most 10 characters`,
      );
    }
    if (seen.has(team.team_id)) {
      throw new Error(`teams[${index}].team_id must be unique`);
    }
    seen.add(team.team_id);
  }
}

function isExcludedRoute(path: string): boolean {
  const pathname = new URL(path, "http://mocked-proxy").pathname;
  return (
    /^\/admin(?:\/|$)/.test(pathname) ||
    // Source and Executor edges and the public webhook intake.
    /^\/v1\//.test(pathname) ||
    /^\/webhook(?:\/|$)/.test(pathname) ||
    /^\/(?!ui\/|auth\/)(?:[^/]+\/)+task$/.test(pathname)
  );
}

function isAllowedUIRoute(path: string): boolean {
  if (
    /^\/ui\/v1\/(?:flows|sources|models|execution-tags|flow-llm-settings)(?:[/?].*)?$/.test(
      path,
    )
  )
    return true;
  return /^\/ui\/v1\/teams\/[^/]+\/(?:dashboard|tasks(?:\/[^/?]+)?|archived-tasks(?:\/[^/?]+)?|executors(?:\/[^/?]+)?|executor-states|launch-parameters(?:\/[^/?]+)?|audit)(?:[/?].*)?$/.test(
    path,
  );
}

function forwardHeaders(
  headers: import("node:http").IncomingHttpHeaders,
): Headers {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      name.startsWith("x-flowai-") ||
      [
        "host",
        "connection",
        "content-length",
        "authorization",
        "x-operator-id",
        "x-team-id",
      ].includes(name)
    ) {
      continue;
    }
    forwarded.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return forwarded;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error: NodeJS.ErrnoException | undefined) =>
      error && error.code !== "ERR_SERVER_NOT_RUNNING"
        ? reject(error)
        : resolve(),
    );
  });
}
