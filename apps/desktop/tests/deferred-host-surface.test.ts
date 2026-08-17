import assert from "node:assert/strict";
import test from "node:test";

import { runDeferredHostSurface } from "../src/composition/deferred-host-surface.js";

test("deferred HostCore UI failure is reported as degradation without escaping", () => {
  const original = new Error("injected Electron surface failure");
  let reported: unknown = null;
  const result = runDeferredHostSurface(() => {
    throw original;
  }, (cause) => {
    reported = cause;
  });
  assert.deepEqual(result, { ok: false, cause: original });
  assert.equal(reported, original);
});

test("deferred HostCore UI failure remains contained when reporting also throws", () => {
  const original = new Error("injected tray failure");
  const result = runDeferredHostSurface(() => {
    throw original;
  }, () => {
    throw new Error("injected logger failure");
  });
  assert.deepEqual(result, { ok: false, cause: original });
});

test("deferred HostCore UI success preserves the operation value", () => {
  assert.deepEqual(runDeferredHostSurface(() => "ready", () => assert.fail("unexpected failure")), { ok: true, value: "ready" });
});
