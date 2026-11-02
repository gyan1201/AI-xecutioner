/**
 * Request-scoped usage attribution.
 *
 * The NIM client reports every call to a single listener. AsyncLocalStorage lets
 * the engine say "everything inside this function belongs to run X, agent Y" —
 * so token accounting stays correct even when calls are nested, parallel or
 * streaming, without threading bookkeeping through every signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const usageStorage = new AsyncLocalStorage();

export function withUsageContext(context, fn) {
  return usageStorage.run(context, fn);
}

export function currentUsageContext() {
  return usageStorage.getStore() ?? null;
}
