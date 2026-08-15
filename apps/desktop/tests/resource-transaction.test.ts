import assert from "node:assert/strict";
import test from "node:test";

import { runResourceTransaction } from "../src/composition/resource-transaction.js";

test("late startup failure rolls resources back in reverse order and preserves the original error", async () => {
  const events: string[] = [];
  const cleanupErrors: unknown[] = [];
  const startupError = new Error("tray menu failed");

  await assert.rejects(
    runResourceTransaction(async (defer) => {
      events.push("capabilities:start");
      defer(() => { events.push("capabilities:stop"); });
      events.push("service:start");
      defer(() => { events.push("service:stop"); throw new Error("service cleanup failed"); });
      events.push("watcher:start");
      defer(() => { events.push("watcher:stop"); });
      events.push("resume:start");
      defer(() => { events.push("resume:stop"); });
      throw startupError;
    }, (error) => cleanupErrors.push(error)),
    (error) => error === startupError,
  );

  assert.deepEqual(events, [
    "capabilities:start",
    "service:start",
    "watcher:start",
    "resume:start",
    "resume:stop",
    "watcher:stop",
    "service:stop",
    "capabilities:stop",
  ]);
  assert.equal(cleanupErrors.length, 1);
  assert.match(String(cleanupErrors[0]), /service cleanup failed/);
});

test("a clean retry commits one resource set and final disposal cleans it exactly once", async () => {
  let attempts = 0;
  let created = 0;
  let rolledBack = 0;
  let disposed = 0;

  const start = async (fail: boolean): Promise<() => void> => runResourceTransaction(async (defer) => {
    attempts += 1;
    created += 1;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (fail) rolledBack += 1;
      else disposed += 1;
    };
    defer(cleanup);
    if (fail) throw new Error("injected startup failure");
    return cleanup;
  });

  await assert.rejects(start(true), /injected startup failure/);
  const dispose = await start(false);
  assert.deepEqual({ attempts, created, rolledBack, disposed }, { attempts: 2, created: 2, rolledBack: 1, disposed: 0 });
  dispose();
  dispose();
  assert.deepEqual({ attempts, created, rolledBack, disposed }, { attempts: 2, created: 2, rolledBack: 1, disposed: 1 });
});
