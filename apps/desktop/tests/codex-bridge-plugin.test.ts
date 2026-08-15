import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  assert.equal(core.selectLifecycleEvent({ hook_event_name: "PermissionRequest", session_id: "session-1" }, 124), null, "Claude-only PermissionRequest must not be advertised as a Codex hook.");
  assert.equal(core.selectLifecycleEvent({ hook_event_name: "PreToolUse", session_id: "session-1" }, 124)?.state, "working");
  assert.equal(core.selectLifecycleEvent({ hook_event_name: "ErrorOccurred", session_id: "session-1" }, 125)?.state, "blocked");
});

test("Codex bridge plugin owns the full local task lifecycle", () => {
  const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
  const pluginRoot = resolve(desktopRoot, "../..", "integrations/codex/plugins/brainpet-codex-bridge");
  const hooks = JSON.parse(readFileSync(resolve(pluginRoot, "hooks/hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["ErrorOccurred", "PostToolUse", "PreToolUse", "SessionEnd", "Stop", "UserPromptSubmit"]);
  assert.equal((hooks.hooks.PreToolUse as Array<{ matcher?: string }>)[0]?.matcher, "*", "Codex PreToolUse must use the supported catch-all matcher.");
  const hookDefinitions = Object.values(hooks.hooks).flatMap((entries) => entries as Array<{ hooks: Array<{ command: string; commandWindows: string; timeout: number }> }>).flatMap((entry) => entry.hooks);
  assert.ok(hookDefinitions.every((hook) => hook.command.includes("bridge.sh")), "Unix hooks must route through the platform-and-architecture-aware launcher.");
  assert.ok(hookDefinitions.every((hook) => hook.commandWindows.includes("bridge.cmd")), "Windows hooks must route through the architecture-aware launcher.");
  assert.ok(hookDefinitions.every((hook) => !hook.command.startsWith("node ") && !hook.commandWindows.startsWith("node ")), "public hook definitions must not directly require Node.");
  assert.ok(hookDefinitions.filter((hook) => hook.timeout > 1).every((hook) => hook.timeout * 1_000 >= 2_600), "activity hooks must contain the full Bridge deadline.");
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
    remainingDeadlineMs(deadline: number, now?: number): number;
  };
  const paths = runtime.getRuntimePaths("win32", { APPDATA: "C:\\Users\\test\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test");
  assert.equal(paths.brainPetDiscovery, "C:\\Users\\test\\AppData\\Roaming\\BrainPet\\runtime\\ipc.json");
  assert.equal("openPetsDevelopmentDiscovery" in paths, false, "BrainPet bridges must not retain an OpenPets discovery fallback.");
  assert.equal(runtime.shouldWakeRuntime({ state: "working" }), true);
  assert.equal(runtime.shouldWakeRuntime({ state: "idle" }), false);
  assert.equal(paths.installMarker, "C:\\Users\\test\\AppData\\Local\\BrainPet\\runtime-install.json");
  const valid = { schemaVersion: 1, product: "brainpet", executablePath: "C:\\Program Files\\BrainPet\\brainpet.exe", appVersion: "1.0.0", channel: "stable", platform: "win32", arch: "x64", writtenAt: 123 };
  assert.equal(runtime.validateInstallMarker(valid, "win32").executablePath, valid.executablePath);
  assert.throws(() => runtime.validateInstallMarker({ ...valid, executablePath: "C:\\Windows\\System32\\cmd.exe" }, "win32"));
  assert.equal(runtime.validateInstallMarker({ ...valid, platform: "linux", executablePath: "/home/test/BrainPet-3.4.0-x86_64.AppImage" }, "linux").executablePath, "/home/test/BrainPet-3.4.0-x86_64.AppImage");
  assert.equal(runtime.remainingDeadlineMs(2_600, 2_250), 350);
  assert.equal(runtime.remainingDeadlineMs(2_600, 2_700), 0);
});

test("Codex bridge rejects an explicitly supplied OpenPets discovery identity", async () => {
  const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? resolve(process.cwd(), "apps/desktop");
  const bridgePath = resolve(desktopRoot, "../..", "integrations/codex/plugins/brainpet-codex-bridge/scripts/bridge.mjs");
  const root = mkdtempSync(join(tmpdir(), "brainpet-bridge-target-"));
  const discoveryPath = join(root, "ipc.json");
  let requests = 0;
  const server = net.createServer((socket) => {
    requests += 1;
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      const request = JSON.parse(chunk.slice(0, chunk.indexOf("\n"))) as { readonly id: string };
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { accepted: true } })}\n`);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge target fixture did not bind.");
  const base = {
    protocol: "openpets-ipc",
    protocolVersion: 1,
    endpoint: `tcp://127.0.0.1:${address.port}`,
    token: "x".repeat(32),
    appVersion: "1.0.0",
    pid: process.pid,
    platform: process.platform,
  };
  try {
    writeFileSync(discoveryPath, JSON.stringify({ ...base, product: "openpets", appId: "dev.openpets.app" }), "utf8");
    await runBridge(bridgePath, discoveryPath);
    assert.equal(requests, 0, "a BrainPet bridge must fail open instead of sending to OpenPets");

    writeFileSync(discoveryPath, JSON.stringify({ ...base, product: "brainpet", appId: "dev.brainpet.app" }), "utf8");
    await runBridge(bridgePath, discoveryPath);
    assert.equal(requests, 1, "the same bridge must accept the matching BrainPet identity");
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

async function runBridge(bridgePath: string, discoveryPath: string): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, OPENPETS_DISCOVERY_FILE: discoveryPath },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`Bridge exited with ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-target", turn_id: "turn-target" }));
  });
}
