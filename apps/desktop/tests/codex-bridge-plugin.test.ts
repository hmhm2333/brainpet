import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("Codex bridge forwards lifecycle fields without prompt or transcript content", async () => {
  const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
  const pluginRoot = resolve(desktopRoot, "../..", "integrations/codex/plugins/brainpet-codex-bridge");
  const core = await import(pathToFileURL(resolve(pluginRoot, "scripts/bridge-core.mjs")).href) as {
    selectLifecycleEvent(value: unknown, occurredAt?: number): Record<string, unknown> | null;
  };
  assert.deepEqual(core.selectLifecycleEvent({ hook_event_name: "UserPromptSubmit", session_id: "session-1", turn_id: "turn-1", prompt: "private", transcript_path: "private" }, 123), {
    schemaVersion: 1,
    agent: "codex",
    sessionId: "session-1",
    turnId: "turn-1",
    state: "working",
    occurredAt: 123,
    capabilities: ["observeLifecycle"],
  });
  assert.equal(core.selectLifecycleEvent({ hook_event_name: "Unknown", session_id: "session-1" }, 123), null);
  assert.deepEqual(core.selectLifecycleEvent({ hook_event_name: "PermissionRequest", session_id: "session-1" }, 124)?.request, { kind: "permission" });
});

test("Codex bridge plugin owns the full local task lifecycle", () => {
  const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
  const pluginRoot = resolve(desktopRoot, "../..", "integrations/codex/plugins/brainpet-codex-bridge");
  const hooks = JSON.parse(readFileSync(resolve(pluginRoot, "hooks/hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PermissionRequest", "PostToolUse", "SessionEnd", "Stop", "UserPromptSubmit"]);
  const hookDefinitions = Object.values(hooks.hooks).flatMap((entries) => entries as Array<{ hooks: Array<{ command: string; commandWindows: string; timeout: number }> }>).flatMap((entry) => entry.hooks);
  assert.ok(hookDefinitions.every((hook) => hook.command.includes("bridge.sh")), "Unix hooks must route through the platform-and-architecture-aware launcher.");
  assert.ok(hookDefinitions.every((hook) => hook.commandWindows.includes("bridge.cmd")), "Windows hooks must route through the architecture-aware launcher.");
  assert.ok(hookDefinitions.every((hook) => !hook.command.startsWith("node ") && !hook.commandWindows.startsWith("node ")), "public hook definitions must not directly require Node.");
  assert.ok(hookDefinitions.filter((hook) => hook.timeout > 1).every((hook) => hook.timeout * 1_000 > 2_500), "activity hooks must outlive the bounded runtime wake window.");
  const unixLauncher = readFileSync(resolve(pluginRoot, "scripts/bridge.sh"), "utf8");
  assert.match(unixLauncher, /Darwin\) platform="macos"/);
  assert.match(unixLauncher, /Linux\) platform="linux"/);
  assert.match(unixLauncher, /arm64\|aarch64\) architecture="arm64"/);
  assert.match(unixLauncher, /x86_64\|amd64\) architecture="x64"/);
  assert.match(unixLauncher, /bin\/\$platform-\$architecture\/brainpet-hook/);
  assert.match(readFileSync(resolve(pluginRoot, "scripts/bridge.cmd"), "utf8"), /windows-x64\\brainpet-hook\.exe/i);
  const bridgeContract = JSON.parse(readFileSync(resolve(pluginRoot, "brainpet.bridge.json"), "utf8")) as { releaseTargets: string[] };
  assert.deepEqual(bridgeContract.releaseTargets, ["windows-x64", "windows-arm64", "macos-x64", "macos-arm64", "linux-x64", "linux-arm64"]);
  const manifest = JSON.parse(readFileSync(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.name, "brainpet-codex-bridge");
  assert.equal("skills" in manifest, false);
});

test("Codex bridge resolves isolated BrainPet runtime paths and rejects arbitrary launch targets", async () => {
  const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
  const pluginRoot = resolve(desktopRoot, "../..", "integrations/codex/plugins/brainpet-codex-bridge");
  const runtime = await import(pathToFileURL(resolve(pluginRoot, "scripts/runtime-core.mjs")).href) as {
    getRuntimePaths(platform: string, environment: Record<string, string>, homeDirectory: string): Record<string, string | null>;
    shouldWakeRuntime(event: { state: string }): boolean;
    validateInstallMarker(value: unknown, platform: string): { executablePath: string };
  };
  const paths = runtime.getRuntimePaths("win32", { APPDATA: "C:\\Users\\test\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test");
  assert.equal(paths.brainPetDiscovery, "C:\\Users\\test\\AppData\\Roaming\\BrainPet\\runtime\\ipc.json");
  assert.equal(runtime.shouldWakeRuntime({ state: "working" }), true);
  assert.equal(runtime.shouldWakeRuntime({ state: "idle" }), false);
  assert.equal(paths.openPetsDevelopmentDiscovery, "C:\\Users\\test\\AppData\\Roaming\\OpenPets\\runtime\\ipc.json");
  assert.equal(paths.installMarker, "C:\\Users\\test\\AppData\\Local\\BrainPet\\runtime-install.json");
  const valid = { schemaVersion: 1, product: "brainpet", executablePath: "C:\\Program Files\\BrainPet\\brainpet.exe", appVersion: "1.0.0", channel: "stable", platform: "win32", arch: "x64", writtenAt: 123 };
  assert.equal(runtime.validateInstallMarker(valid, "win32").executablePath, valid.executablePath);
  assert.throws(() => runtime.validateInstallMarker({ ...valid, executablePath: "C:\\Windows\\System32\\cmd.exe" }, "win32"));
});
