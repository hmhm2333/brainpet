import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrainPetAdapterManager, BrainPetAdapterOperationError, type BrainPetCommandRunner } from "../src/brainpet-adapter-manager.js";
import { brainPetBridgeVersion } from "../src/generated-brainpet-distribution.js";

const codexExecutable = "C:\\Program Files\\Codex\\codex.exe";
const target = { id: "windows-x64", helperName: "brainpet-hook.exe" } as const;

interface FakePlugin {
  pluginId: string;
  name: string;
  version: string;
}

function createFixture(input: { readonly plugins?: readonly FakePlugin[]; readonly marketplaces?: readonly string[]; readonly failure?: string; readonly brainPetMarketplaceRoot?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "brainpet-adapter-manager-"));
  const userDataPath = join(root, "user-data");
  const codexHome = join(root, "codex-home");
  const marketplaceRoot = join(root, "marketplace");
  const pluginRoot = join(marketplaceRoot, "plugins", "brainpet-codex-bridge");
  mkdirSync(join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(join(pluginRoot, "bin", target.id), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "brainpet", plugins: [{ name: "brainpet-codex-bridge", source: { source: "local", path: "./plugins/brainpet-codex-bridge" } }] }));
  writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "brainpet-codex-bridge", version: brainPetBridgeVersion }));
  writeFileSync(join(pluginRoot, "brainpet.bridge.json"), JSON.stringify({ bridgeVersion: brainPetBridgeVersion, transportPriority: ["native-hook"] }));
  const helper = Buffer.from("fixture-native-helper");
  const helperPath = join(pluginRoot, "bin", target.id, target.helperName);
  writeFileSync(helperPath, helper);
  writeFileSync(join(marketplaceRoot, "brainpet-bundle.json"), JSON.stringify({
    schemaVersion: 1,
    product: "brainpet",
    target: target.id,
    bridgeVersion: brainPetBridgeVersion,
    helper: { path: `plugins/brainpet-codex-bridge/bin/${target.id}/${target.helperName}`, bytes: helper.length, sha256: createHash("sha256").update(helper).digest("hex") },
    nodeFallbackBundled: false,
  }));

  const state = {
    plugins: [...(input.plugins ?? [])],
    marketplaces: [...(input.marketplaces ?? [])],
    commands: [] as string[],
    failure: input.failure ?? null as string | null,
  };
  const configPath = join(codexHome, "config.toml");
  const runner: BrainPetCommandRunner = async (_executable, args, options) => {
    const key = args.join(" ");
    state.commands.push(key);
    assert.equal(options.env.CODEX_HOME, codexHome);
    if (key === "--version") return result(0, "codex-cli 0.147.0\n");
    if (key === "plugin list --json") return result(0, JSON.stringify({ installed: state.plugins, available: [] }));
    if (key === "plugin marketplace list --json") return result(0, JSON.stringify({ marketplaces: state.marketplaces.map((name) => ({ name, root: name === "brainpet" ? input.brainPetMarketplaceRoot ?? marketplaceRoot : root })) }));
    appendFileSync(configPath, `# ${key}\n`, "utf8");
    if (state.failure === key) {
      state.failure = null;
      return result(17, "", "injected failure");
    }
    if (args[0] === "plugin" && args[1] === "remove") state.plugins = state.plugins.filter((plugin) => plugin.pluginId !== args[2]);
    if (key === "plugin marketplace remove brainpet --json") state.marketplaces = state.marketplaces.filter((name) => name !== "brainpet");
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") state.marketplaces = [...new Set([...state.marketplaces, "brainpet"])];
    if (key === "plugin add brainpet-codex-bridge@brainpet --json") state.plugins = [{ pluginId: "brainpet-codex-bridge@brainpet", name: "brainpet-codex-bridge", version: brainPetBridgeVersion }];
    return result(0, "{}\n");
  };
  let operation = 0;
  const manager = new BrainPetAdapterManager({
    userDataPath,
    marketplaceRoot,
    codexHome,
    platform: "win32",
    arch: "x64",
    runCommand: runner,
    resolveCodexExecutable: async () => codexExecutable,
    now: () => 1_786_800_000_000 + operation,
    createOperationId: () => `fixture-${String(++operation).padStart(4, "0")}`,
  });
  return { root, userDataPath, codexHome, marketplaceRoot, helperPath, configPath, state, manager };
}

test("adapter status distinguishes missing Codex from an invalid bundled helper", async () => {
  const fixture = createFixture();
  try {
    const unavailable = new BrainPetAdapterManager({
      userDataPath: fixture.userDataPath,
      marketplaceRoot: fixture.marketplaceRoot,
      codexHome: fixture.codexHome,
      platform: "win32",
      arch: "x64",
      runCommand: async () => result(1),
      resolveCodexExecutable: async () => null,
    });
    assert.deepEqual(await unavailable.getStatus(), {
      agent: "unavailable", bridge: "not-installed", installedVersion: null, bundledVersion: brainPetBridgeVersion, codexCliVersion: null, canConnect: false, reason: "codex-not-found",
    });
    rmSync(fixture.helperPath);
    const invalidBundle = await fixture.manager.getStatus();
    assert.equal(invalidBundle.agent, "detected");
    assert.equal(invalidBundle.canConnect, false);
    assert.equal(invalidBundle.reason, "bundle-invalid");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Windows detection skips an inaccessible app executable and accepts a verified codex.cmd shim", async () => {
  const fixture = createFixture();
  try {
    const calls: string[] = [];
    const manager = new BrainPetAdapterManager({
      userDataPath: fixture.userDataPath,
      marketplaceRoot: fixture.marketplaceRoot,
      codexHome: fixture.codexHome,
      platform: "win32",
      arch: "x64",
      runCommand: async (executable, args) => {
        calls.push(`${executable} ${args.join(" ")}`);
        if (executable === "where.exe") return result(0, "C:\\Program Files\\Codex\\codex.exe\r\nD:\\Tools\\codex.cmd\r\n");
        if (executable.endsWith("codex.exe")) return result(1);
        if (args.join(" ") === "--version") return result(0, "codex-cli 0.147.0\n");
        if (args.join(" ") === "plugin list --json") return result(0, JSON.stringify({ installed: [], available: [] }));
        return result(1);
      },
    });
    const status = await manager.getStatus();
    assert.equal(status.agent, "detected");
    assert.equal(status.codexCliVersion, "0.147.0");
    assert.ok(calls.some((call) => call.startsWith("D:\\Tools\\codex.cmd --version")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an equal-version selector from a different marketplace root still requires upgrade", async () => {
  const fixture = createFixture({
    plugins: [{ pluginId: "brainpet-codex-bridge@brainpet", name: "brainpet-codex-bridge", version: brainPetBridgeVersion }],
    marketplaces: ["brainpet"],
    brainPetMarketplaceRoot: "C:\\Untrusted\\brainpet",
  });
  try {
    const status = await fixture.manager.getStatus();
    assert.equal(status.bridge, "upgrade-required");
    assert.equal(status.canConnect, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("one-click install backs up config, connects the bundled selector, and writes a receipt", async () => {
  const fixture = createFixture();
  try {
    const original = "model = \"gpt-5\"\n";
    writeFileSync(fixture.configPath, original);
    const operation = await fixture.manager.connectOrUpgrade();
    assert.equal(operation.receipt.operation, "install");
    assert.equal(operation.receipt.status, "succeeded");
    assert.equal(operation.receipt.configBackup.existed, true);
    assert.equal(operation.receipt.configBackup.sha256, createHash("sha256").update(original).digest("hex"));
    assert.equal(operation.status.bridge, "installed");
    assert.ok(fixture.state.commands.includes(`plugin marketplace add ${fixture.marketplaceRoot} --json`));
    assert.ok(fixture.state.commands.includes("plugin add brainpet-codex-bridge@brainpet --json"));
    assert.ok(existsSync(join(fixture.userDataPath, "adapter-receipts", "codex-latest.json")));
    assert.equal(readFileSync(join(fixture.userDataPath, operation.receipt.configBackup.path!), "utf8"), original);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("upgrade removes every legacy BrainPet selector before installing the explicit product-profile selector", async () => {
  const fixture = createFixture({ plugins: [
    { pluginId: "brainpet-codex-bridge@personal", name: "brainpet-codex-bridge", version: "0.1.0" },
    { pluginId: "brainpet-codex-bridge@brainpet", name: "brainpet-codex-bridge", version: "0.2.0" },
  ], marketplaces: ["personal", "brainpet"] });
  try {
    writeFileSync(fixture.configPath, "original=true\n");
    const operation = await fixture.manager.connectOrUpgrade();
    assert.equal(operation.receipt.operation, "upgrade");
    assert.deepEqual(operation.receipt.previousSelectors, ["brainpet-codex-bridge@personal", "brainpet-codex-bridge@brainpet"]);
    assert.ok(fixture.state.commands.includes("plugin remove brainpet-codex-bridge@personal --json"));
    assert.ok(fixture.state.commands.includes("plugin remove brainpet-codex-bridge@brainpet --json"));
    assert.equal(operation.status.bridge, "installed");
    assert.deepEqual(fixture.state.plugins.map((plugin) => plugin.pluginId), ["brainpet-codex-bridge@brainpet"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall removes the plugin and marketplace without touching unrelated selectors", async () => {
  const fixture = createFixture({ plugins: [
    { pluginId: "brainpet-codex-bridge@brainpet", name: "brainpet-codex-bridge", version: brainPetBridgeVersion },
    { pluginId: "documents@official", name: "documents", version: "1.0.0" },
  ], marketplaces: ["brainpet", "official"] });
  try {
    writeFileSync(fixture.configPath, "installed=true\n");
    const operation = await fixture.manager.uninstall();
    assert.equal(operation.receipt.operation, "uninstall");
    assert.equal(operation.status.bridge, "not-installed");
    assert.deepEqual(fixture.state.plugins.map((plugin) => plugin.pluginId), ["documents@official"]);
    assert.deepEqual(fixture.state.marketplaces, ["official"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a failed install restores the exact config bytes and records a rolled-back receipt", async () => {
  const fixture = createFixture({
    plugins: [{ pluginId: "brainpet-codex-bridge@personal", name: "brainpet-codex-bridge", version: "0.1.0" }],
    marketplaces: ["personal"],
    failure: "plugin add brainpet-codex-bridge@brainpet --json",
  });
  try {
    const original = Buffer.from("# preserved bytes\r\nmodel = \"gpt-5\"\r\n", "utf8");
    writeFileSync(fixture.configPath, original);
    await assert.rejects(fixture.manager.connectOrUpgrade(), (error: unknown) => error instanceof BrainPetAdapterOperationError && error.code === "plugin-add-failed");
    assert.deepEqual(readFileSync(fixture.configPath), original);
    const receipt = JSON.parse(readFileSync(join(fixture.userDataPath, "adapter-receipts", "codex-latest.json"), "utf8"));
    assert.equal(receipt.status, "rolled-back");
    assert.equal(receipt.rollbackApplied, true);
    assert.equal(receipt.errorCode, "plugin-add-failed");
    assert.equal(JSON.stringify(receipt).includes("preserved bytes"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function result(code: number, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}
