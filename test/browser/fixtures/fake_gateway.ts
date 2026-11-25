import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

// Test-local fake of the API Gateway `/ui/v1` surface (mocked-proxy spec,
// v0048). It keeps its state in memory for one test file, opens no broker,
// platform-service or Executor connection, and numbers every record with a
// positive integer as its real owner does (tasks, Flows, Sources and
// environments per team; Executors and frames globally). Replies follow the
// owning services' reply schemas (svc/<service>/schemas/).

export type Task = {
  task_id: number;
  /** task-manager's stored task name (v0050): `<team_name>-<task_id>`. */
  task_name: string;
  flow_id: number;
  external_id: string;
  source_id: number;
  current_state: string;
  attempt: number;
  claim_seq: number;
  executor_id: number | null;
  ingested_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  environment: Record<string, string>;
  secret_keys: string[];
};

export type ExecutorRecord = {
  executor_id: number;
  team_id: number;
  execution_tag: string;
  executor_type: string;
  created_at: string;
  token_fingerprint: string;
  token_issued_at: string;
  reported_ip: string | null;
  ip_reported_at: string | null;
};

export type ExecutorState = {
  executor_id: number;
  connection_state: string;
  connection_changed_at: string | null;
  held_claims: number | null;
  max_parallel_tasks: number | null;
  available_capacity: number | null;
  reported_ip: string | null;
  ip_changed_at: string | null;
};

export type GatewayRequest = {
  method: string;
  path: string;
  team: number | null;
  body: unknown;
};

export type FakeGateway = {
  origin: string;
  /** The single team the fake serves. */
  teamId: number;
  tasks: Task[];
  launchParameters: any[];
  audit: any[];
  executors: ExecutorRecord[];
  executorStates: ExecutorState[];
  executorEvents: Map<number, any[]>;
  taskEvents: Map<number, any[]>;
  /** Every request the fake answered, in order. */
  requests: GatewayRequest[];
  /** The query string of every accepted stream upgrade. */
  streamQueries: URLSearchParams[];
  /** Sends a frame to the team's open streams and keeps it for replay. */
  push: (teamId: number, frame: Record<string, unknown>) => number;
  disconnectStreams: (teamId: number) => void;
  rejectStreams: (teamId: number, rejected: boolean) => void;
  close: () => Promise<void>;
};

const iso = (time: number) => new Date(time).toISOString();
const millis = (time: number) => new Date(time).toISOString(); // .sssZ
const notFound = { code: "not_found", message: "resource not found" };

export async function startFakeGateway(
  teamId = 1,
  otherTeams: readonly number[] = [],
  teamName = "alpha",
): Promise<FakeGateway> {
  const now = Date.now();
  const states = ["queued", "created", "running", "finished", "failed"];
  const tasks: Task[] = Array.from({ length: 18 }, (_, index) => {
    const current_state = states[index % states.length];
    const claimed = current_state !== "queued";
    return {
      task_id: index + 1,
      task_name: `${teamName}-${index + 1}`,
      flow_id: index % 2 ? 2 : 1,
      source_id: 4,
      external_id: `external-${index + 1}`,
      current_state,
      attempt: 1,
      claim_seq: claimed ? 1 : 0,
      executor_id: claimed ? 7 : null,
      ingested_at: iso(now - index * 60_000),
      claimed_at: claimed ? iso(now - index * 60_000 + 5_000) : null,
      completed_at: ["finished", "failed"].includes(current_state)
        ? iso(now - index * 60_000 + 35_000)
        : null,
      environment: { FLOWAI_VISIBLE: "fixture-value", WORKSPACE: "/workspace" },
      secret_keys: ["FLOWAI_SECRET"],
    };
  });
  const launchParameters: any[] = [
    {
      environment_id: 1,
      team_id: teamId,
      scope: "team",
      flow_id: null,
      name: "Team parameters",
      env: { FLOWAI_VISIBLE: "fixture-value" },
      revision: 2,
      secrets: [
        {
          secret_id: 1,
          key: "FLOWAI_SECRET",
          current_version: 2,
          revoked: false,
        },
      ],
      created_at: iso(now - 60_000),
      updated_at: iso(now),
    },
    {
      environment_id: 2,
      team_id: teamId,
      scope: "flow",
      flow_id: 1,
      name: "Repositories",
      env: { WORKSPACE: "/workspace" },
      revision: 1,
      secrets: [],
      created_at: iso(now),
      updated_at: iso(now),
    },
  ];
  const audit = Array.from({ length: 15 }, (_, index) => ({
    audit_id: index + 1,
    actor_id: 11,
    actor_type: "operator",
    action: index % 3 ? "environment.replace" : "task.control.requested",
    resource_type: index % 3 ? "environment" : "task_control_request",
    resource_id: index % 3 ? 1 : 41,
    request_id: 9000 + index,
    outcome: "succeeded",
    occurred_at: iso(now - index * 1_000),
  }));
  const fingerprint = (seed: number) =>
    seed.toString(16).padStart(2, "0").repeat(32);
  const executors: ExecutorRecord[] = [
    {
      executor_id: 7,
      team_id: teamId,
      execution_tag: "openhands",
      executor_type: "executor_docker_openhands",
      created_at: millis(now - 86_400_000),
      token_fingerprint: fingerprint(7),
      token_issued_at: millis(now - 86_400_000),
      reported_ip: "192.0.2.10",
      ip_reported_at: millis(now - 60_000),
    },
    {
      executor_id: 8,
      team_id: teamId,
      execution_tag: "openhands",
      executor_type: "executor_k8s_openhands",
      created_at: millis(now - 86_000_000),
      token_fingerprint: fingerprint(8),
      token_issued_at: millis(now - 86_000_000),
      reported_ip: null,
      ip_reported_at: null,
    },
  ];
  const executorStates: ExecutorState[] = [
    {
      executor_id: 7,
      connection_state: "connected",
      connection_changed_at: millis(now - 3_600_000),
      held_claims: 1,
      max_parallel_tasks: 2,
      available_capacity: 1,
      reported_ip: "192.0.2.10",
      ip_changed_at: millis(now - 3_600_000),
    },
  ];
  const executorEvents = new Map<number, any[]>([
    [
      7,
      [
        stored(
          101,
          "executor-registry",
          "executor_status",
          millis(now - 3_600_000),
          {
            team_id: teamId,
            executor_id: 7,
          },
          {
            connection_state: "connected",
            held_claims: 1,
            max_parallel_tasks: 2,
            available_capacity: 1,
          },
        ),
      ],
    ],
  ]);
  const taskEvents = new Map<number, any[]>();
  let nextEventID = 1000;
  for (const task of tasks) {
    if (task.current_state === "queued") continue;
    const claimed = new Date(task.claimed_at!).getTime();
    const event = (kind: string, offset: number, extra = {}) =>
      stored(
        nextEventID++,
        "executor",
        kind,
        iso(claimed + offset),
        {
          team_id: teamId,
          task_id: task.task_id,
          attempt: 1,
          claim_seq: 1,
          executor_id: 7,
        },
        extra,
      );
    const items = [event("created", 0)];
    if (task.current_state !== "created") items.push(event("running", 1_000));
    if (task.current_state === "finished")
      items.push(event("finished", 30_000));
    if (task.current_state === "failed")
      items.push(
        event("failed", 30_000, {
          failure_reason: "agent_error",
          retryable: false,
        }),
      );
    taskEvents.set(task.task_id, items);
  }
  const requests: GatewayRequest[] = [];
  const streamQueries: URLSearchParams[] = [];
  const sockets = new Map<number, Set<WebSocket>>();
  const frames = new Map<number, Record<string, unknown>[]>();
  const rejectedStreams = new Set<number>();
  let nextFrameID = 5000;
  let nextExecutorID = 13;

  // The working bearer the mocked proxy issues is `working-<team_id>`.
  const bearerTeam = (header: string | undefined) => {
    const match = /^Bearer working-([1-9][0-9]{0,17})$/.exec(header ?? "");
    return match ? Number(match[1]) : null;
  };
  const known = (team: number) => team === teamId || otherTeams.includes(team);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-gateway");
    const team = bearerTeam(request.headers.authorization);
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? null
        : await readJSON(request);
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname + url.search,
      team,
      body,
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    // A Gateway route without a verified working bearer is unauthorized.
    if (team === null || !known(team))
      return json(response, 401, { code: "unauthorized" });
    if (url.pathname === "/ui/v1/sources" && request.method === "GET")
      return json(response, 200, {
        items: [
          {
            source_id: 4,
            name: "listener-alpha",
            team_id: team,
            mode: "webhook",
            enabled: true,
            settings_status: "ready",
          },
        ],
        next_cursor: null,
      });
    if (url.pathname === "/ui/v1/flows" && request.method === "GET")
      return json(response, 200, {
        items: [
          { flow_id: 1, name: "Repository task" },
          { flow_id: 2, name: "Code review" },
        ],
        next_cursor: null,
      });
    const match = url.pathname.match(/^\/ui\/v1\/teams\/([^/]+)(\/.*)$/);
    if (!match) return json(response, 404, notFound);
    const [, pathTeam, route] = match;
    // The path team must be the verified team; another team is not found.
    if (!/^[1-9][0-9]*$/.test(pathTeam))
      return json(response, 400, { code: "invalid_request" });
    if (Number(pathTeam) !== team) return json(response, 404, notFound);
    // Another known team owns no records in this fake.
    const own = team === teamId;
    if (route === "/dashboard" && request.method === "GET") {
      const counts = Object.fromEntries(
        [
          "queued",
          "created",
          "pending",
          "running",
          "finished",
          "failed",
          "cancelled",
        ].map((state) => [state, 0]),
      ) as Record<string, number>;
      if (own) tasks.forEach((task) => counts[task.current_state]++);
      const period = url.searchParams.get("period") ?? "week";
      const buckets =
        period === "month"
          ? calendarMonthBuckets(url.searchParams.get("month"), tasks)
          : isoWeekBuckets(url.searchParams.get("week"), tasks);
      return json(response, 200, { period, counts, buckets });
    }
    if (route === "/tasks" && request.method === "GET") {
      let items = own ? [...tasks] : [];
      const status = url.searchParams.get("status"),
        term = url.searchParams.get("search") ?? "",
        search = term.toLowerCase();
      if (status) items = items.filter((item) => item.current_state === status);
      const date = url.searchParams.get("date");
      if (date)
        items = items.filter((item) => item.ingested_at.slice(0, 10) === date);
      // task-manager (v0050): a term that is the full task name of a
      // stored task (any case, surrounding spaces ignored) finds only that
      // task; any other term keeps the broad external-ID search.
      const named = items.filter(
        (item) => item.task_name === term.trim().toLowerCase(),
      );
      if (named.length) items = named;
      else if (search)
        items = items.filter((item) =>
          item.external_id.toLowerCase().includes(search),
        );
      const limit = Number(url.searchParams.get("limit") ?? 10),
        offset = Number(url.searchParams.get("cursor") ?? 0);
      return json(response, 200, {
        items: items
          .slice(offset, offset + limit)
          .map((item) => summary(item, team)),
        next_cursor:
          offset + limit < items.length ? String(offset + limit) : null,
      });
    }
    if (!own) {
      if (
        request.method === "GET" &&
        /^\/(executors|executor-states|launch-parameters|audit|archived-tasks)$/.test(
          route,
        )
      )
        return json(response, 200, { items: [], next_cursor: null });
      if (request.method === "GET") return json(response, 404, notFound);
    }
    const taskMatch = route.match(
      /^\/tasks\/([^/]+)(\/events|\/logs|\/attempts|\/launch-parameters|\/controls\/cancel)?$/,
    );
    if (taskMatch) {
      if (!/^[1-9][0-9]*$/.test(taskMatch[1]))
        return json(response, 400, { code: "invalid_request" });
      const task = tasks.find((item) => item.task_id === Number(taskMatch[1]));
      if (!task) return json(response, 404, notFound);
      if (!taskMatch[2] && request.method === "GET")
        return json(response, 200, card(task, team));
      if (taskMatch[2] === "/launch-parameters" && request.method === "GET")
        return json(response, 200, {
          task_id: task.task_id,
          attempt: task.current_state === "queued" ? null : task.attempt,
          environment: task.current_state === "queued" ? {} : task.environment,
          secret_keys: task.current_state === "queued" ? [] : task.secret_keys,
        });
      if (taskMatch[2] === "/events" && request.method === "GET")
        return json(response, 200, {
          items: taskEvents.get(task.task_id) ?? [],
          next_cursor: null,
        });
      if (taskMatch[2] === "/attempts" && request.method === "GET")
        return json(response, 200, {
          task_id: task.task_id,
          items: attempts(task),
        });
      if (taskMatch[2] === "/logs" && request.method === "GET")
        return json(response, 200, {
          items: [
            {
              event_id: 9001 + task.task_id * 10,
              task_id: task.task_id,
              attempt: 1,
              claim_seq: 1,
              executor_id: task.executor_id,
              log_offset: 1,
              stream: "reasoning",
              text: "Inspecting the workspace",
              publisher_seq: 1,
              occurred_at: task.claimed_at,
            },
            {
              event_id: 9002 + task.task_id * 10,
              task_id: task.task_id,
              attempt: 1,
              claim_seq: 1,
              executor_id: task.executor_id,
              log_offset: 2,
              stream: "work",
              text: "FlowAI marker written",
              publisher_seq: 2,
              occurred_at: task.claimed_at,
            },
          ],
          next_cursor: null,
        });
      if (taskMatch[2] === "/controls/cancel" && request.method === "POST")
        return json(response, 202, {
          task_id: task.task_id,
          control_id: 41,
          control: "cancel",
          status: "requested",
        });
    }
    if (route === "/executor-states" && request.method === "GET")
      return json(response, 200, { items: executorStates });
    if (route === "/executors" && request.method === "GET")
      return json(response, 200, {
        items: executors,
        next_cursor: null,
        total_count: executors.length,
      });
    if (route === "/executors" && request.method === "POST") {
      const input = (body ?? {}) as Record<string, unknown>;
      const keys = Object.keys(input).sort().join(",");
      if (keys !== "execution_tag,executor_type")
        return json(response, 400, { code: "invalid_request" });
      const created: ExecutorRecord = {
        executor_id: nextExecutorID++,
        team_id: team,
        execution_tag: String(input.execution_tag),
        executor_type: String(input.executor_type),
        created_at: millis(Date.now()),
        token_fingerprint: fingerprint(nextExecutorID),
        token_issued_at: millis(Date.now()),
        reported_ip: null,
        ip_reported_at: null,
      };
      executors.push(created);
      return json(response, 201, {
        ...created,
        token: `fake-jwt-${created.executor_id}`,
      });
    }
    const executorMatch = route.match(
      /^\/executors\/([^/]+)(\/events|\/tasks|\/token)?$/,
    );
    if (executorMatch) {
      if (!/^[1-9][0-9]*$/.test(executorMatch[1]))
        return json(response, 400, { code: "invalid_request" });
      const executor = executors.find(
        (item) => item.executor_id === Number(executorMatch[1]),
      );
      if (!executor)
        return json(response, 404, {
          code: "executor_unknown_or_unavailable",
          message: "Executor is unknown or unavailable",
        });
      if (!executorMatch[2] && request.method === "GET")
        return json(response, 200, executor);
      if (!executorMatch[2] && request.method === "DELETE") {
        executors.splice(executors.indexOf(executor), 1);
        response.writeHead(204).end();
        return;
      }
      if (executorMatch[2] === "/token" && request.method === "POST")
        return json(response, 200, {
          executor_id: executor.executor_id,
          token: `fake-jwt-${executor.executor_id}-reissued`,
          token_fingerprint: fingerprint(99),
          token_issued_at: millis(Date.now()),
        });
      if (executorMatch[2] === "/events")
        return json(response, 200, {
          items: executorEvents.get(executor.executor_id) ?? [],
          next_cursor: null,
        });
      if (executorMatch[2] === "/tasks")
        return json(response, 200, {
          items: tasks
            .filter(
              (task) =>
                task.executor_id === executor.executor_id &&
                (!url.searchParams.get("status") ||
                  task.current_state === url.searchParams.get("status")),
            )
            .map((task) => summary(task, team)),
          next_cursor: null,
        });
    }
    if (route === "/launch-parameters" && request.method === "GET") {
      const scope = url.searchParams.get("scope");
      return json(response, 200, {
        items: scope
          ? launchParameters.filter((item) => item.scope === scope)
          : launchParameters,
        next_cursor: null,
      });
    }
    if (route === "/launch-parameters" && request.method === "POST") {
      const created = {
        environment_id:
          Math.max(0, ...launchParameters.map((item) => item.environment_id)) +
          1,
        team_id: team,
        revision: 1,
        secrets: [],
        created_at: iso(Date.now()),
        updated_at: iso(Date.now()),
        ...(body as object),
      };
      launchParameters.push(created);
      return json(response, 201, created);
    }
    const secretMatch = route.match(
      /^\/launch-parameters\/([^/]+)\/secrets\/([^/]+)(\/versions)?$/,
    );
    if (secretMatch) {
      const env = launchParameters.find(
        (item) => item.environment_id === Number(secretMatch[1]),
      );
      const secret = env?.secrets.find(
        (item: any) => item.secret_id === Number(secretMatch[2]),
      );
      if (!env || !secret) return json(response, 404, notFound);
      if (secretMatch[3] === "/versions" && request.method === "GET")
        return json(response, 200, {
          items: Array.from({ length: secret.current_version }, (_, index) => ({
            version: index + 1,
            created_at: iso(now + index),
          })),
          next_cursor: null,
        });
      if (!secretMatch[3] && request.method === "PUT") {
        secret.current_version += 1;
        return json(response, 200, secret);
      }
      if (!secretMatch[3] && request.method === "DELETE") {
        env.secrets.splice(env.secrets.indexOf(secret), 1);
        response.writeHead(204).end();
        return;
      }
    }
    const envMatch = route.match(
      /^\/launch-parameters\/([^/]+)(\/revisions|\/secrets)?$/,
    );
    if (envMatch) {
      const env = launchParameters.find(
        (item) => item.environment_id === Number(envMatch[1]),
      );
      if (!env) return json(response, 404, notFound);
      if (!envMatch[2] && request.method === "GET")
        return json(response, 200, env);
      if (!envMatch[2] && request.method === "PUT") {
        Object.assign(env, body, {
          revision: env.revision + 1,
          updated_at: iso(Date.now()),
        });
        return json(response, 200, env);
      }
      if (!envMatch[2] && request.method === "DELETE") {
        launchParameters.splice(launchParameters.indexOf(env), 1);
        response.writeHead(204).end();
        return;
      }
      if (envMatch[2] === "/revisions")
        return json(response, 200, {
          items: [
            { ...env, revision: env.revision, deleted: false },
            { ...env, revision: 1, deleted: false },
          ],
          next_cursor: null,
        });
      if (envMatch[2] === "/secrets" && request.method === "POST") {
        const input = body as { key: string };
        const secret = {
          secret_id:
            Math.max(
              0,
              ...launchParameters.flatMap((item) =>
                item.secrets.map((entry: any) => entry.secret_id),
              ),
            ) + 1,
          key: input.key,
          current_version: 1,
          revoked: false,
        };
        env.secrets.push(secret);
        return json(response, 201, secret);
      }
    }
    if (route === "/audit" && request.method === "GET") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const items = audit.filter(
        (item) =>
          !search || JSON.stringify(item).toLowerCase().includes(search),
      );
      return json(response, 200, { items, next_cursor: null });
    }
    return json(response, 404, notFound);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://fake-gateway");
    const match = url.pathname.match(/^\/ui\/v1\/teams\/([^/]+)\/stream$/);
    const team = bearerTeam(
      decodeBearerProtocol(request.headers["sec-websocket-protocol"]),
    );
    if (!match || team === null || Number(match[1]) !== team) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const after = url.searchParams.get("after_frame_id");
    if (after !== null && !/^[1-9][0-9]*$/.test(after)) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (rejectedStreams.has(team)) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    streamQueries.push(url.searchParams);
    wss.handleUpgrade(request, socket, head, (ws) => {
      const set = sockets.get(team) ?? new Set<WebSocket>();
      set.add(ws);
      sockets.set(team, set);
      ws.on("close", () => set.delete(ws));
      // Replay the frames after the browser's cursor, then continue live.
      if (after !== null)
        for (const frame of frames.get(team) ?? [])
          if (Number(frame.frame_id) > Number(after))
            ws.send(JSON.stringify(frame));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    teamId,
    tasks,
    launchParameters,
    audit,
    executors,
    executorStates,
    executorEvents,
    taskEvents,
    requests,
    streamQueries,
    push(team, frame) {
      const stored = { ...frame, frame_id: frame.frame_id ?? nextFrameID++ };
      nextFrameID = Math.max(nextFrameID, Number(stored.frame_id) + 1);
      const history = frames.get(team) ?? [];
      history.push(stored);
      frames.set(team, history);
      for (const ws of sockets.get(team) ?? [])
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(stored));
      return Number(stored.frame_id);
    },
    rejectStreams(team, rejected) {
      if (rejected) rejectedStreams.add(team);
      else rejectedStreams.delete(team);
    },
    disconnectStreams(team) {
      for (const ws of sockets.get(team) ?? [])
        ws.close(1012, "Owned reconnect fixture");
    },
    close: () => closeServer(server, wss, sockets),
  };
}

// The browser carries its bearer in the `flowai.bearer.<base64url>` protocol.
function decodeBearerProtocol(header: string | undefined) {
  const value = (header ?? "")
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("flowai.bearer."));
  if (!value) return undefined;
  const encoded = value.slice("flowai.bearer.".length);
  return `Bearer ${Buffer.from(encoded, "base64url").toString()}`;
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
) {
  response.writeHead(status).end(JSON.stringify(value));
}
async function readJSON(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}
async function closeServer(
  server: Server,
  wss: WebSocketServer,
  sockets: Map<number, Set<WebSocket>>,
) {
  for (const set of sockets.values()) for (const ws of set) ws.terminate();
  wss.close();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function isoWeekBuckets(requestedWeek: string | null, tasks: Task[]) {
  const today = new Date();
  const fallback = isoWeekKey(today);
  const match = /^(\d{4})-W(\d{2})$/.exec(requestedWeek ?? fallback);
  const year = Number(match?.[1] ?? fallback.slice(0, 4));
  const week = Number(match?.[2] ?? fallback.slice(6));
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(januaryFourth);
  monday.setUTCDate(
    januaryFourth.getUTCDate() -
      (januaryFourth.getUTCDay() || 7) +
      1 +
      (week - 1) * 7,
  );
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
    (shortLabel, index) => {
      const date = new Date(monday);
      date.setUTCDate(monday.getUTCDate() + index);
      const dayTasks = tasks.filter(
        (task) =>
          task.ingested_at.slice(0, 10) === date.toISOString().slice(0, 10),
      );
      return {
        key: date.toISOString().slice(0, 10),
        label: shortLabel,
        shortLabel,
        total: dayTasks.length,
        counts: summarize(dayTasks),
        isFuture: date.getTime() > today.getTime(),
      };
    },
  );
}

function calendarMonthBuckets(requestedMonth: string | null, tasks: Task[]) {
  const current = new Date();
  const fallback = `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, "0")}`;
  const [year, month] = (
    /^\d{4}-\d{2}$/.test(requestedMonth ?? "") ? requestedMonth! : fallback
  )
    .split("-")
    .map(Number);
  return Array.from(
    { length: new Date(Date.UTC(year, month, 0)).getUTCDate() },
    (_, index) => {
      const date = new Date(Date.UTC(year, month - 1, index + 1));
      const dayTasks = tasks.filter(
        (task) =>
          task.ingested_at.slice(0, 10) === date.toISOString().slice(0, 10),
      );
      return {
        key: date.toISOString().slice(0, 10),
        label: String(index + 1),
        shortLabel: String(index + 1),
        total: dayTasks.length,
        counts: summarize(dayTasks),
        isFuture: date.getTime() > current.getTime(),
      };
    },
  );
}

function summarize(tasks: Task[]) {
  const counts: Record<string, number> = {};
  for (const task of tasks)
    counts[task.current_state] = (counts[task.current_state] ?? 0) + 1;
  return counts;
}

function isoWeekKey(date: Date) {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return `${utc.getUTCFullYear()}-W${String(Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

/** A journal-stored event: the publisher's flat message plus event_id. */
export function stored(
  event_id: number,
  publisher: string,
  kind: string,
  occurred_at: string,
  keys: {
    team_id: number;
    task_id?: number;
    attempt?: number;
    claim_seq?: number;
    executor_id?: number;
    control_id?: number;
  },
  data: Record<string, unknown> = {},
) {
  return {
    event_id,
    publisher,
    publisher_seq: event_id,
    occurred_at,
    kind,
    ...keys,
    ...data,
  };
}

const IMAGE = "ghcr.io/flowai/openhands@sha256:" + "1".repeat(64);

/** task-manager taskSummary of a fake task. */
export function summary(task: Task, team_id: number) {
  return {
    task_id: task.task_id,
    task_name: task.task_name,
    team_id,
    flow_id: task.flow_id,
    source_id: task.source_id,
    external_id: task.external_id,
    required_tag: "openhands",
    current_state: task.current_state,
    attempt: task.attempt,
    executor_id: task.executor_id,
    ingested_at: task.ingested_at,
    claimed_at: task.claimed_at,
    completed_at: task.completed_at,
  };
}

/** task-manager attempts of a fake task (one attempt, at most one claim). */
export function attempts(task: Task) {
  const terminal = ["finished", "failed"].includes(task.current_state);
  return [
    {
      attempt: 1,
      state: task.current_state,
      failure_reason: task.current_state === "failed" ? "agent_error" : null,
      retryable: task.current_state === "failed" ? false : null,
      claims:
        task.executor_id === null
          ? []
          : [
              {
                attempt: 1,
                claim_seq: 1,
                executor_id: task.executor_id,
                claimed_at: task.claimed_at,
                resolved_image: IMAGE,
                image_source: "flow_default",
                pending_reasons: [],
                released_reason: null,
                ended_at: terminal ? task.completed_at : null,
              },
            ],
    },
  ];
}

/** task-manager taskCard of a fake task. */
export function card(task: Task, team_id: number) {
  return {
    ...summary(task, team_id),
    intake_id: 5000 + task.task_id,
    claim_seq: task.claim_seq || 1,
    resolved_image: task.executor_id === null ? null : IMAGE,
    image_source: task.executor_id === null ? null : "flow_default",
    next_due_at: null,
    next_due_kind: null,
    execution_revision: 1,
    failure_retry_count: 3,
    failure_retry_wait_seconds: 60,
    pending_limit_seconds: 900,
    release_delay_seconds: 300,
    final_reason: null,
    archived: false,
    attempts: attempts(task),
    history: [],
  };
}
