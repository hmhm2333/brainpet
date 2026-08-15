import assert from "node:assert/strict";
import test from "node:test";

import { AsyncOperationDisposedError, AsyncOperationGate } from "../src/composition/async-operation-gate.js";

test("dispose blocks new work and drains in-flight work before resolving", async () => {
  const gate = new AsyncOperationGate("fixture");
  let release: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  let postAwaitSideEffects = 0;
  const operation = gate.run(async (assertActive) => {
    await deferred;
    assertActive();
    postAwaitSideEffects += 1;
  });

  const disposing = gate.dispose();
  assert.throws(() => gate.run(async () => undefined), AsyncOperationDisposedError);
  release?.();
  await assert.rejects(operation, AsyncOperationDisposedError);
  await disposing;

  assert.equal(postAwaitSideEffects, 0);
});

test("dispose waits for cleanup-safe work that already passed its last guard", async () => {
  const gate = new AsyncOperationGate("fixture");
  let release: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  const operation = gate.run(async (assertActive) => {
    assertActive();
    await deferred;
    completed = true;
  });

  let disposed = false;
  const disposing = gate.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  release?.();
  await Promise.all([operation, disposing]);
  assert.equal(completed, true);
});
