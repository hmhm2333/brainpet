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
