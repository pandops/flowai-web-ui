import { test as base } from "@playwright/test";
import { closeMockedProxySockets } from "./mocked_proxy";
import { closeCaseResources } from "./case-lifecycle";
import { closeWorkerProxies } from "./worker-proxy";
export * from "@playwright/test";

// The v0048 Source contract: source-controller's operator Source view
// (`sources-get`, `sources-list` items) and settings view
// (`sources-settings-get`). A Source carries its all-time `intake_counts`;
// Flow bindings are Flow-owned `source_ids`. A mocked reply with a field the
// real Gateway never sends would let a Web UI that reads it pass here and
// fail on the stand (bugfix-14), so every Source reply a test serves may use
// only these fields. Fixtures may omit fields.
const SOURCE_VIEW = new Set([
  "id",
  "source_id",
  "team_id",
  "name",
  "mode",
  "contract_version",
  "implementation_version",
  "description",
  "filter_summary",
  "enabled",
  "revision",
  "settings_status",
  "health",
  "activity",
  "intake_counts",
  "created_at",
  "polling",
  "last_poll",
  "webhook_url",
  "last_seen_at",
  "observed_counters",
]);
const INTAKE_COUNTS = [
  "published",
  "rejected",
  "accepted",
  "deduplicated",
  "no_target",
  "failed",
];
const SETTINGS_VIEW = new Set([
  "source_id",
  "mode",
  "settings_status",
  "schema_revision",
  "revision",
  "platform",
  "fields",
  "polling",
  "last_poll",
]);
const SETTINGS_PLATFORM = new Set([
  "webhook_url",
  "poll_url",
  "poll_interval_minutes",
]);
const extra = (value: any, allowed: Set<string>) =>
  value && typeof value === "object"
    ? Object.keys(value).filter((key) => !allowed.has(key))
    : [];
export function sourceContractDrift(path: string, body: any): string[] {
  const drift: string[] = [];
  if (/^\/ui\/v1\/sources\/[^/]+\/settings$/.test(path)) {
    for (const key of extra(body, SETTINGS_VIEW)) drift.push(`${path}: ${key}`);
    for (const key of extra(body?.platform, SETTINGS_PLATFORM))
      drift.push(`${path}: platform.${key}`);
    return drift;
  }
  if (!/^\/ui\/v1\/sources(?:\/[^/]+)?$/.test(path)) return drift;
  const sources = Array.isArray(body?.items) ? body.items : [body];
  for (const source of sources) {
    if (!source || typeof source !== "object" || !("source_id" in source))
      continue;
    const name = `${path} Source ${source.source_id}`;
    for (const key of extra(source, SOURCE_VIEW)) drift.push(`${name}: ${key}`);
    const counts = source.intake_counts;
    if (
      "intake_counts" in source &&
      (!counts ||
        INTAKE_COUNTS.some((key) => !Number.isInteger(counts[key])) ||
        extra(counts, new Set(INTAKE_COUNTS)).length)
    )
      drift.push(`${name}: intake_counts is not ${INTAKE_COUNTS.join(", ")}`);
  }
  return drift;
}

export const test = base.extend({
    _workerProxies: [
      async ({}, use) => {
        try {
          await use();
        } finally {
          await closeWorkerProxies();
        }
      },
      { scope: "worker", auto: true, timeout: 120_000 },
    ],
    _caseResources: [
      async ({}, use) => {
        try {
          await use();
        } finally {
          await closeCaseResources();
        }
      },
      { auto: true, timeout: 30_000 },
    ],
    context: async ({ context }, use) => {
      // Keep every resource entry so per-cell external-request checks see a
      // complete Resource Timing record even on long pages.
      await context.addInitScript(() =>
        performance.setResourceTimingBufferSize(100000),
      );
      const errors: unknown[] = [];
      const drift: string[] = [];
      const reads: Promise<void>[] = [];
      // Read a Source body only once its request has finished. A response
      // whose body never completes (the page navigated away mid-transfer, or
      // a held reply) keeps response.json() pending until the context
      // closes; awaiting it before close deadlocks the teardown (flake-2).
      // Such a body never reached the page, so it has no contract to check.
      context.on("requestfinished", (request) => {
        const path = new URL(request.url()).pathname;
        if (!path.startsWith("/ui/v1/sources") || request.method() !== "GET")
          return;
        reads.push(
          (async () => {
            let body: unknown;
            try {
              const response = await request.response();
              if (!response?.ok()) return;
              body = await response.json();
            } catch {
              return;
            }
            drift.push(...sourceContractDrift(path, body));
          })(),
        );
      });
      try {
        await use(context);
      } catch (error) {
        errors.push(error);
      }
      await Promise.all(reads);
      if (drift.length)
        errors.push(
          new Error(
            `Mocked Source replies carry fields outside the v0048 contract:\n${[...new Set(drift)].join("\n")}`,
          ),
        );
      for (const close of [() => context.close(), closeMockedProxySockets]) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, "Browser/proxy cleanup failed");
    },
});
