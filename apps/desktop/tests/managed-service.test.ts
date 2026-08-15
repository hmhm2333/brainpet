import assert from "node:assert/strict";
import test from "node:test";

import { DesktopServiceLifecycle, type DesktopManagedService, type DesktopServiceState } from "../src/composition/managed-service.js";

function service(id: string, events: string[], options: { readonly failStart?: boolean } = {}): DesktopManagedService {
  let state: DesktopServiceState = "created";
  return {
    id,
    async start() {
      events.push(`start:${id}`);
      if (options.failStart) {
        state = "failed";
        throw new Error(`failed:${id}`);
      }
      state = "started";
    },
    async dispose() {
      events.push(`dispose:${id}`);
      state = "disposed";
    },
    diagnostics: () => ({ id, state }),
  };
}

test("desktop services start once and dispose once in reverse order", async () => {
  const events: string[] = [];
  const lifecycle = new DesktopServiceLifecycle([
    () => service("host", events),
    () => service("feature", events),
  ]);

  await Promise.all([lifecycle.start(), lifecycle.start()]);
  await Promise.all([lifecycle.dispose(), lifecycle.dispose()]);

  assert.deepEqual(events, ["start:host", "start:feature", "dispose:feature", "dispose:host"]);
  assert.deepEqual(lifecycle.diagnostics().map((entry) => entry.state), ["disposed", "disposed"]);
});

test("a failed service start rolls back every created service", async () => {
  const events: string[] = [];
  const lifecycle = new DesktopServiceLifecycle([
    () => service("host", events),
    () => service("optional", events, { failStart: true }),
  ]);

  await assert.rejects(lifecycle.start(), /failed:optional/);
  assert.deepEqual(events, ["start:host", "start:optional", "dispose:optional", "dispose:host"]);
});

test("dispose during a pending start prevents later factories and disposes once", async () => {
  const events: string[] = [];
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let laterFactoryCalls = 0;
  const pendingService = service("pending", events);
  pendingService.start = async () => {
    events.push("start:pending");
    await startGate;
  };
  const lifecycle = new DesktopServiceLifecycle([
    () => pendingService,
    () => {
      laterFactoryCalls += 1;
      return service("late", events);
    },
  ]);

  const starting = lifecycle.start();
  await Promise.resolve();
  const disposing = lifecycle.dispose();
  releaseStart?.();
  await Promise.all([starting, disposing]);
  await lifecycle.dispose();

  assert.equal(laterFactoryCalls, 0);
  assert.deepEqual(events, ["start:pending", "dispose:pending"]);
  assert.equal(lifecycle.diagnostics()[0]?.state, "disposed");
});

test("dispose while a factory is pending disposes its result without starting it", async () => {
  const events: string[] = [];
  let releaseFactory: ((value: DesktopManagedService) => void) | undefined;
  const factoryGate = new Promise<DesktopManagedService>((resolve) => { releaseFactory = resolve; });
  const lifecycle = new DesktopServiceLifecycle([() => factoryGate]);

  const starting = lifecycle.start();
  await Promise.resolve();
  const disposing = lifecycle.dispose();
  releaseFactory?.(service("created", events));
  await Promise.all([starting, disposing]);

  assert.deepEqual(events, ["dispose:created"]);
});
