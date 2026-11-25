import type { Page } from "@playwright/test";

type Definition = {
  environment_id: number;
  scope: "global" | "team" | "flow";
  flow_id: number | null;
  name: string;
  revision: number;
  created_at?: string;
  env: Record<string, string>;
  secrets: {
    secret_id: number;
    key?: string;
    name?: string;
    version?: number;
    latest_version?: number;
    created_at?: string;
  }[];
};

export async function parameterFixture(page: Page) {
  const definitions: Definition[] = [
    {
      environment_id: 7041,
      scope: "global",
      flow_id: null,
      name: "Global defaults",
      revision: 1,
      env: { SHARED: "global-value" },
      secrets: [],
    },
    {
      environment_id: 7042,
      scope: "team",
      flow_id: null,
      name: "Team defaults",
      revision: 2,
      env: { SHARED: "team-value" },
      secrets: [],
    },
    {
      environment_id: 7043,
      scope: "flow",
      flow_id: 7002,
      name: "Review defaults",
      revision: 3,
      env: { SHARED: "flow-value" },
      secrets: [
        {
          secret_id: 7044,
          key: "TOKEN",
          version: 1,
          created_at: "2026-10-18T00:30:00Z",
        },
      ],
    },
  ];
  definitions.forEach((definition, index) => {
    definition.created_at = new Date(
      Date.UTC(2026, 9, 18, 0, index),
    ).toISOString();
  });
  const flows = [{ flow_id: 7002, name: "Review flow" }];
  const writes: {
    path: string;
    method: string;
    body: any;
    headers: Record<string, string>;
  }[] = [];
  await page.route("**/ui/v1/flows?**", (route) =>
    route.fulfill({
      json: {
        items: flows,
        next_cursor: null,
      },
    }),
  );
  await page.route("**/ui/v1/teams/1/launch-parameters**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET") {
      const body = request.postData() ? request.postDataJSON() : null;
      writes.push({
        path: url.pathname,
        method: request.method(),
        body,
        headers: request.headers(),
      });
      if (request.method() === "DELETE") {
        const id = Number(url.pathname.split("/")[6]);
        const index = definitions.findIndex(
          (definition) => definition.environment_id === id,
        );
        if (index >= 0) definitions.splice(index, 1);
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({
        status: 201,
        json: {
          secret_id: 7045,
          key: body.key,
          version: 1,
        },
      });
      return;
    }
    const rawID = url.pathname.split("/")[6];
    const id = rawID ? Number(rawID) : undefined;
    const definition = definitions.find(
      (definition) => definition.environment_id === id,
    );
    if (id && (!definition || definition.scope === "global"))
      return route.fulfill({ status: 404, json: { code: "not_found" } });
    if (id && url.pathname.endsWith("/revisions"))
      return route.fulfill({
        json: {
          items: [
            {
              revision: definition!.revision,
              created_at: definition!.created_at,
            },
          ],
          next_cursor: null,
        },
      });
    if (id && url.pathname.endsWith("/versions"))
      return route.fulfill({
        json: {
          items: [{ version: 1, created_at: definition!.created_at }],
          next_cursor: null,
        },
      });
    if (id)
      return route.fulfill({
        json: definition,
      });
    const scope = url.searchParams.get("scope");
    const flowID = url.searchParams.get("flow_id"),
      limit = Number(url.searchParams.get("limit") || "10");
    await route.fulfill({
      json: {
        items: definitions
          .filter(
            (definition) =>
              (!scope || definition.scope === scope) &&
              (!flowID || definition.flow_id === Number(flowID)),
          )
          .sort(
            (left, right) =>
              String(left.created_at || "").localeCompare(
                String(right.created_at || ""),
              ) || left.environment_id - right.environment_id,
          )
          .slice(0, limit),
        next_cursor: null,
      },
    });
  });
  return { definitions, writes, flows };
}
