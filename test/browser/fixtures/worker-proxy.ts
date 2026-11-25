import { test } from "@playwright/test";
import type { MockedProxy } from "./mocked_proxy";

// One mocked proxy per spec file and worker, started by the first test that
// needs it and closed when the worker ends (owned-test.ts). A file-level
// beforeAll would make Playwright run the file's tests in contiguous chunks,
// one chunk per worker, so long neighbouring tests could not spread out.
const proxies = new Map<string, Promise<MockedProxy>>();

export function workerProxy(
  start: () => Promise<MockedProxy>,
): Promise<MockedProxy> {
  const info = test.info();
  let proxy = proxies.get(info.file);
  if (!proxy) {
    proxy = start();
    proxies.set(info.file, proxy);
    proxy.catch(() => proxies.delete(info.file));
  }
  return proxy;
}

export async function closeWorkerProxies(): Promise<void> {
  const started = [...proxies.values()];
  proxies.clear();
  const errors: unknown[] = [];
  for (const pending of started) {
    const proxy = await pending.catch(() => undefined);
    try {
      await proxy?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Mocked proxy cleanup failed");
}
