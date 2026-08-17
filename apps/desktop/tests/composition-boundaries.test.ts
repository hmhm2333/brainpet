import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { configureOptionalUiPort, openOptionalControlCenter } from "../src/optional-ui-port.js";
import { configurePetPluginPort, getDefaultPetPluginCommands } from "../src/pet-plugin-port.js";
import { configureOptionalLanPetPort, reclampOptionalLanPetWindows } from "../src/lan-pet-port.js";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
const source = (path: string): string => readFileSync(resolve(desktopRoot, "src", path), "utf8");

test("BrainPet HostCore has no reverse dependency on product or optional services", () => {
  const hostCore = source("composition/host-core.ts");
  const lifecycle = source("lifecycle.ts");
  const brainPetHost = source("brainpet/host.ts");
  const defaultPetController = source("default-pet-controller.ts");
  const optionalRuntime = source("composition/openpets-runtime.ts");
  const main = source("main.ts");

  assert.doesNotMatch(hostCore, /from "\.\.\/(?:brainpet(?:\/|-)|plugin-service|plugin-runtime|windows\.js|lan-controller|remote-control|plugin-voice)/i);
  assert.doesNotMatch(lifecycle, /from "\.\/(?:plugin|brainpet|remote-control|lan-|local-ipc|default-pet|agent-pet|windows\.js)/i);
  assert.doesNotMatch(brainPetHost, /plugin-service|plugin-runtime|plugin-events-source|brainpet\.training/);
  assert.doesNotMatch(defaultPetController, /^import .*lan-pet-controller/m);
  assert.match(optionalRuntime, /AsyncOperationGate/);
  assert.match(optionalRuntime, /startPluginPlatformTransaction/);
  assert.match(optionalRuntime, /stopPluginService\(service\)/);
  assert.match(main, /import\("\.\/composition\/openpets-runtime\.js"\)/);
  assert.match(main, /import\("\.\/composition\/brainpet-feature\.js"\)/);
  assert.match(main, /distribution\.profile === "brainpet" && process\.platform === "win32"[\s\S]*appendSwitch\("in-process-gpu"\)/);
  assert.doesNotMatch(main, /^import .*composition\/(?:openpets-runtime|brainpet-feature)\.js/m);
});

test("optional UI and plugin ports do not load work until invoked", async () => {
  let uiLoads = 0;
  let pluginLoads = 0;
  let lanReclamps = 0;
  configureOptionalUiPort({
    openControlCenter: async () => { uiLoads += 1; },
    focusOpenTasks: () => undefined,
  });
  configurePetPluginPort({
    getCommands: async () => { pluginLoads += 1; return []; },
    getMenuItems: async () => [],
    executeCommand: async () => null,
    executeMenuSelect: async () => undefined,
    publishPetEvent: () => undefined,
    reclampPetWindows: () => undefined,
  });
  configureOptionalLanPetPort({ reclampPetWindows: () => { lanReclamps += 1; } });

  assert.equal(uiLoads, 0);
  assert.equal(pluginLoads, 0);
  assert.equal(lanReclamps, 0);
  openOptionalControlCenter("dashboard");
  await Promise.resolve();
  await getDefaultPetPluginCommands();
  reclampOptionalLanPetWindows();
  assert.equal(uiLoads, 1);
  assert.equal(pluginLoads, 1);
  assert.equal(lanReclamps, 1);

  configureOptionalUiPort(null);
  configurePetPluginPort(null);
  configureOptionalLanPetPort(null);
});
