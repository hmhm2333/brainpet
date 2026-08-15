import assert from "node:assert/strict";

import { createInstallerPlan, defineAdapterDescriptor, resolveTargetProfile } from "./index.js";

const target = resolveTargetProfile("brainpet", "win32", { APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local" }, "C:\\Users\\Test");
assert.deepEqual(target, {
  product: "brainpet",
  appId: "dev.brainpet.app",
  discoveryPath: "C:\\Roaming\\BrainPet\\runtime\\ipc.json",
  runtimeMarkerPath: "C:\\Local\\BrainPet\\runtime-install.json",
  updateChannel: "hmhm2333/brainpet",
  adapterVersion: "1.0.0",
});

const descriptor = defineAdapterDescriptor({
  id: "fixture",
  displayName: "Fixture",
  supportedProducts: ["brainpet"],
  automaticLifecycle: true,
  lifecycleMethod: "agent.activity",
  installerKind: "codex-plugin",
  capabilities: { lifecycle: "implemented", taskNavigation: "unavailable", requestActions: "unavailable", message: "unavailable", voice: "unavailable" },
});
assert.equal(descriptor.lifecycleMethod, "agent.activity");
assert.throws(() => defineAdapterDescriptor({ ...descriptor, lifecycleMethod: null }));
assert.equal(createInstallerPlan({ providerId: "fixture", installerKind: "codex-plugin", target, scope: "global", mode: "install" }).target, target);

console.error("Adapter core validation passed.");
