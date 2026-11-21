import { setTimeout as delay } from "node:timers/promises";

const releases = new Set<() => Promise<void>>();
let caseSignal = new AbortController();
const waits = new Set<Promise<void>>();

export function ownCaseResource(cleanup: () => Promise<void>) {
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= cleanup().finally(() => releases.delete(close)));
  releases.add(close);
  return close;
}

export async function closeCaseResources() {
  caseSignal.abort();
  await Promise.allSettled(waits);
  caseSignal = new AbortController();
  const outcomes = await Promise.allSettled([...releases].map((close) => close()));
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (errors.length) throw new AggregateError(errors, "Web UI case cleanup failed");
}

export default {
  sleep(milliseconds: number) {
    const waiting = delay(milliseconds, undefined, { signal: caseSignal.signal })
      .finally(() => waits.delete(waiting));
    waits.add(waiting);
    return waiting;
  },
};
