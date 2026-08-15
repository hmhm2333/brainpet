import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBrainPetInstallMarker, getBrainPetInstallMarkerPath, readValidBrainPetInstallMarker, resolveBrainPetMarkerExecutablePath, validateBrainPetInstallMarker, writeBrainPetInstallMarker } from "../src/brainpet-install-marker.js";

test("BrainPet install markers use product-specific per-user paths", () => {
  assert.equal(getBrainPetInstallMarkerPath("win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test"), "C:\\Users\\test\\AppData\\Local\\BrainPet\\runtime-install.json");
  assert.equal(getBrainPetInstallMarkerPath("darwin", {}, "/Users/test"), "/Users/test/Library/Application Support/BrainPet/runtime-install.json");
  assert.equal(getBrainPetInstallMarkerPath("linux", { XDG_CONFIG_HOME: "/home/test/.config" }, "/home/test"), "/home/test/.config/BrainPet/runtime-install.json");
});

test("Linux AppImage markers keep the persistent launcher path", () => {
  assert.equal(
    resolveBrainPetMarkerExecutablePath("/tmp/.mount_BrainPet/brainpet", "linux", { APPIMAGE: "/home/test/BrainPet-3.4.0-x86_64.AppImage" }),
    "/home/test/BrainPet-3.4.0-x86_64.AppImage",
  );
  assert.equal(
    validateBrainPetInstallMarker(createBrainPetInstallMarker({ executablePath: "/home/test/BrainPet-3.4.0-x86_64.AppImage", appVersion: "3.4.0", platform: "linux", arch: "x64", writtenAt: 123 }), "linux").product,
    "brainpet",
  );
  assert.equal(resolveBrainPetMarkerExecutablePath("/opt/BrainPet/brainpet", "linux", { APPIMAGE: "/home/test/not-brainpet.AppImage" }), "/opt/BrainPet/brainpet");
});

test("BrainPet install marker accepts only a direct platform executable", () => {
  const marker = createBrainPetInstallMarker({ executablePath: "C:\\Program Files\\BrainPet\\brainpet.exe", appVersion: "1.0.0", platform: "win32", arch: "x64", writtenAt: 123 });
  assert.equal(validateBrainPetInstallMarker(marker, "win32").product, "brainpet");
  assert.throws(() => validateBrainPetInstallMarker({ ...marker, executablePath: "C:\\Windows\\System32\\cmd.exe" }, "win32"), /name/);
  assert.throws(() => validateBrainPetInstallMarker({ ...marker, executablePath: "brainpet.exe" }, "win32"), /path/);
  assert.throws(() => validateBrainPetInstallMarker({ ...marker, channel: "nightly" }, "win32"), /channel/);
});

test("setup validation rejects stale markers whose executable is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "brainpet-marker-"));
  try {
    const executablePath = join(root, "brainpet.exe");
    const markerPath = join(root, "runtime-install.json");
    const marker = createBrainPetInstallMarker({ executablePath, appVersion: "1.0.0", platform: "win32", arch: "x64", writtenAt: 123 });
    writeFileSync(markerPath, JSON.stringify(marker));
    assert.equal(readValidBrainPetInstallMarker(markerPath, "win32"), null);
    writeFileSync(executablePath, "fixture");
    assert.equal(readValidBrainPetInstallMarker(markerPath, "win32")?.appVersion, "1.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker writes keep an atomic last-known-good recovery copy", () => {
  const root = mkdtempSync(join(tmpdir(), "brainpet-marker-backup-"));
  try {
    const markerPath = join(root, "runtime-install.json");
    const marker = createBrainPetInstallMarker({ executablePath: "C:\\Program Files\\BrainPet\\brainpet.exe", appVersion: "1.0.0", platform: "win32", arch: "x64", writtenAt: 123 });
    assert.equal(writeBrainPetInstallMarker(marker, markerPath), markerPath);
    assert.deepEqual(readFileSync(`${markerPath}.bak`), readFileSync(markerPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
