import assert from "node:assert/strict";
import test from "node:test";

import { createBrainPetInstallMarker, getBrainPetInstallMarkerPath, validateBrainPetInstallMarker } from "../src/brainpet-install-marker.js";

test("BrainPet install markers use product-specific per-user paths", () => {
  assert.equal(getBrainPetInstallMarkerPath("win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test"), "C:\\Users\\test\\AppData\\Local\\BrainPet\\runtime-install.json");
  assert.equal(getBrainPetInstallMarkerPath("darwin", {}, "/Users/test"), "/Users/test/Library/Application Support/BrainPet/runtime-install.json");
  assert.equal(getBrainPetInstallMarkerPath("linux", { XDG_CONFIG_HOME: "/home/test/.config" }, "/home/test"), "/home/test/.config/BrainPet/runtime-install.json");
});

test("BrainPet install marker accepts only a direct platform executable", () => {
  const marker = createBrainPetInstallMarker({ executablePath: "C:\\Program Files\\BrainPet\\brainpet.exe", appVersion: "1.0.0", platform: "win32", arch: "x64", writtenAt: 123 });
  assert.equal(validateBrainPetInstallMarker(marker, "win32").product, "brainpet");
  assert.throws(() => validateBrainPetInstallMarker({ ...marker, executablePath: "C:\\Windows\\System32\\cmd.exe" }, "win32"), /name/);
  assert.throws(() => validateBrainPetInstallMarker({ ...marker, executablePath: "brainpet.exe" }, "win32"), /path/);
  assert.throws(() => validateBrainPetInstallMarker({ ...marker, channel: "nightly" }, "win32"), /channel/);
});
