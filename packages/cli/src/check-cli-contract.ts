import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { assertSafeProjectHookPath, cliPackageName, configureProject, createClaudeMcpAddJsonArgs, createLocalDevCliCommand, createVersionPinnedCliCommand, installProjectLocalHooks, parseConfigureArgs, parseDoctorArgs, parseInstallArgs, parsePluginNewArgs, parseReactArgs, parseSayArgs, resolveConfiguredPet, runClaudeMcpAddJson, runDoctor, scaffoldPlugin } from "./index.js";
import { pluginTemplateNames } from "./plugin-templates.js";
import { validatePluginFolder } from "./plugin-validate.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { readonly version: string }).version;
const cliEntryPath = fileURLToPath(new URL("./index.js", import.meta.url));

const targeted = (args: readonly string[]): readonly string[] => ["--product", "openpets", ...args];
const parsed = parseConfigureArgs(targeted(["--agent", "claude", "--pet", "fixer", "--cwd", "/tmp/project", "--yes"]));
assert.equal(parsed.product, "openpets");
assert.equal(parsed.agent, "claude");
assert.equal(parsed.petId, "fixer");
assert.equal(parsed.cwd, "/tmp/project");
assert.equal(parsed.yes, true);
assert.equal(parseConfigureArgs(targeted(["--pet", "fixer", "--force"])).force, true);
assert.equal(parseConfigureArgs(targeted(["--pet", "fixer", "--replace"])).force, true);
assert.equal(parseConfigureArgs(targeted(["--pet", "fixer", "--local-dev"])).localDev, true);
assert.equal(parseConfigureArgs(targeted(["--pet=fixer"])).petId, "fixer");
assert.equal(parseConfigureArgs(targeted(["--agent", "opencode", "--pet", "fixer"])).agent, "opencode");
assert.equal(parseConfigureArgs(targeted(["--agent", "cursor", "--pet", "fixer"])).agent, "cursor");
assert.equal(parseConfigureArgs(targeted(["--agent", "cursor", "--pet", "fixer"])).cwd, process.cwd());
assert.equal(parseConfigureArgs(targeted(["--agent", "cursor", "--rules-only"])).cursorRulesMode, "only");
assert.equal(parseConfigureArgs(targeted(["--agent", "cursor", "--remove-rules"])).cursorRulesMode, "remove");
assert.equal(parseConfigureArgs(targeted(["--agent", "cursor", "--with-rules"])).cursorRulesMode, "with");
assert.throws(() => parseConfigureArgs(targeted(["--agent", "cursor", "--with-rules", "--rules-only"])));
assert.throws(() => parseConfigureArgs(targeted(["--agent", "claude", "--rules-only"])));
assert.throws(() => parseConfigureArgs(targeted(["--pet", "bad/pet"])));
assert.throws(() => parseConfigureArgs(["--pet", "fixer"]), /Missing required --product/);
assert.deepEqual(parseInstallArgs(targeted(["review-owl"])), { product: "openpets", petId: "review-owl" });
assert.deepEqual(parseInstallArgs(targeted(["--from-zip", "my-pet.zip"])), { product: "openpets", fromZip: "my-pet.zip" });
assert.deepEqual(parseInstallArgs(targeted(["--from-zip=my-pet.zip"])), { product: "openpets", fromZip: "my-pet.zip" });
assert.deepEqual(parseInstallArgs(targeted(["--from-folder", "my-folder"])), { product: "openpets", fromFolder: "my-folder" });
assert.deepEqual(parseInstallArgs(targeted(["--from-folder=my-folder"])), { product: "openpets", fromFolder: "my-folder" });
assert.throws(() => parseInstallArgs([]));
assert.throws(() => parseInstallArgs(targeted(["bad/pet"])));
assert.throws(() => parseInstallArgs(targeted(["review-owl", "--from-zip", "my-pet.zip"])));
assert.throws(() => parseInstallArgs(targeted(["--from-zip", "my-pet.zip", "--from-folder", "my-folder"])));
assert.throws(() => parseInstallArgs(targeted(["--from-zip"])));
assert.throws(() => parseInstallArgs(targeted(["--from-folder"])));
assert.deepEqual(parseReactArgs(targeted(["success"])), { product: "openpets", reaction: "success" });
assert.throws(() => parseReactArgs([]));
assert.throws(() => parseReactArgs(targeted(["bad"])));
assert.deepEqual(parseSayArgs(targeted(["Build", "finished"])), { product: "openpets", message: "Build finished", reaction: undefined });
assert.deepEqual(parseSayArgs(targeted(["Build finished", "--reaction", "celebrating"])), { product: "openpets", message: "Build finished", reaction: "celebrating" });
assert.deepEqual(parseSayArgs(targeted(["--reaction=success", "Tests", "passed"])), { product: "openpets", message: "Tests passed", reaction: "success" });
assert.throws(() => parseSayArgs([]));
assert.throws(() => parseSayArgs(targeted(["Hello", "--reaction", "bad"])));
assert.throws(() => parseSayArgs(targeted(["Hello", "--unknown"])));

assert.deepEqual(parseDoctorArgs(targeted([])), { product: "openpets", cwd: process.cwd(), json: false });
assert.equal(parseDoctorArgs(targeted(["--json"])).json, true);
assert.equal(parseDoctorArgs(targeted(["--cwd", "/tmp/project"])).cwd, "/tmp/project");
assert.equal(parseDoctorArgs(targeted(["--cwd=/tmp/project"])).cwd, "/tmp/project");
assert.deepEqual(parseDoctorArgs(targeted(["--cwd=/tmp/project", "--json"])), { product: "openpets", cwd: "/tmp/project", json: true });
assert.throws(() => parseDoctorArgs(targeted(["--unknown"])));
assert.throws(() => parseDoctorArgs(targeted(["--cwd"])));

assert.deepEqual(parsePluginNewArgs(["My Plugin"]), { name: "My Plugin", id: "local.my-plugin", dir: "my-plugin", author: undefined, template: "blank" });
assert.equal(parsePluginNewArgs(["My Plugin", "--id", "acme.my-plugin"]).id, "acme.my-plugin");
assert.equal(parsePluginNewArgs(["My Plugin", "--dir", "/tmp/p"]).dir, "/tmp/p");
assert.equal(parsePluginNewArgs(["My Plugin", "--author=Jane"]).author, "Jane");
assert.equal(parsePluginNewArgs(["My Plugin", "--template", "tamagotchi"]).template, "tamagotchi");
assert.throws(() => parsePluginNewArgs([]));
assert.throws(() => parsePluginNewArgs(["x", "--id", ".bad"]));
assert.throws(() => parsePluginNewArgs(["x", "--unknown"]));
assert.throws(() => parsePluginNewArgs(["x", "--template", "nope"]));
assert.throws(() => parsePluginNewArgs(["!!!"]));

const pluginScaffoldDir = mkdtempSync(join(tmpdir(), "openpets-plugin-"));
try {
  const target = join(pluginScaffoldDir, "demo");
  const result = scaffoldPlugin({ name: "Demo Plugin", id: "local.demo", dir: target, template: "blank" });
  assert.equal(result.manifestPath, join(target, "openpets.plugin.json"));
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { readonly manifestVersion: number; readonly id: string; readonly entry: string; readonly sdkVersion: string; readonly permissions: readonly string[] };
  assert.equal(manifest.manifestVersion, 3);
  assert.equal(manifest.id, "local.demo");
  assert.equal(manifest.entry, "index.js");
  assert.ok(manifest.sdkVersion.startsWith("3."));
  assert.ok(manifest.permissions.includes("commands"));
  const entry = readFileSync(result.entryPath, "utf8");
  assert.match(entry, /OpenPetsPlugin\.register/);
  assert.match(entry, /reference types="@open-pets\/plugin-sdk"/);
  assert.ok(existsSync(join(target, "README.md")));
  assert.ok(existsSync(join(target, "test.js")));
  assert.equal(validatePluginFolder(target).ok, true, JSON.stringify(validatePluginFolder(target).issues));
  const petConfigManifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as Record<string, unknown>;
  petConfigManifest.configSchema = { companion: { type: "pet", label: "Companion" } };
  writeFileSync(result.manifestPath, JSON.stringify(petConfigManifest, null, 2), "utf8");
  assert.equal(validatePluginFolder(target).ok, false, "legacy pet config fields are removed");
  assert.throws(() => scaffoldPlugin({ name: "Demo Plugin", id: "local.demo", dir: target, template: "blank" }));

  // Every template scaffolds to a folder that passes author-time validation.
  for (const template of pluginTemplateNames) {
    const templateTarget = join(pluginScaffoldDir, `tpl-${template}`);
    scaffoldPlugin({ name: `Demo ${template}`, id: `local.demo-${template}`, dir: templateTarget, template });
    const validation = validatePluginFolder(templateTarget);
    assert.equal(validation.ok, true, `${template}: ${JSON.stringify(validation.issues)}`);
  }
  // The validator catches missing referenced files.
  rmSync(join(target, "index.js"));
  assert.equal(validatePluginFolder(target).ok, false);
} finally {
  rmSync(pluginScaffoldDir, { recursive: true, force: true });
}

const pinned = createVersionPinnedCliCommand("1.2.3", ["mcp", "--pet", "fixer"]);
assert.deepEqual(pinned, { command: "npx", args: ["-y", `${cliPackageName}@1.2.3`, "mcp", "--pet", "fixer"] });
const localDev = createLocalDevCliCommand(["mcp", "--pet", "fixer"]);
assert.equal(localDev.command, process.execPath);
assert.deepEqual(localDev.args.slice(-3), ["mcp", "--pet", "fixer"]);

let listPetsCalled = false;
const offlineExplicitPet = await resolveConfiguredPet({
  listPets: async () => {
    listPetsCalled = true;
    throw new Error("desktop unavailable");
  },
}, "fixer");
assert.deepEqual(offlineExplicitPet, { id: "fixer", displayName: "fixer" });
assert.equal(listPetsCalled, false);

const mcpArgs = createClaudeMcpAddJsonArgs({ type: "stdio", command: pinned.command, args: pinned.args, env: {} });
assert.deepEqual(mcpArgs.slice(0, 3), ["mcp", "add-json", "openpets"]);
assert.equal(mcpArgs.at(-2), "--scope");
assert.equal(mcpArgs.at(-1), "local");
const mcpJson = JSON.parse(mcpArgs[3] ?? "{}") as { readonly command?: string; readonly args?: readonly string[] };
assert.equal(mcpJson.command, "npx");
assert.deepEqual(mcpJson.args, ["-y", `${cliPackageName}@1.2.3`, "mcp", "--pet", "fixer"]);

const dir = mkdtempSync(join(tmpdir(), "openpets-cli-"));
try {
  const project = join(dir, "project");
  const settingsDir = join(project, ".claude");
  mkdirSync(project);
  writeFileSync(join(dir, "placeholder"), "x", "utf8");
  assert.throws(() => assertSafeProjectHookPath(join(dir, "missing")));
  installProjectLocalHooks(project, "npx -y @open-pets/cli@1.2.3 hook --openpets-managed --project-local --pet fixer");
  const settingsPath = join(settingsDir, "settings.local.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { readonly hooks?: Record<string, Array<{ readonly hooks: Array<{ readonly command: string }> }>> };
  assert.ok(settings.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.command.includes("--project-local --pet fixer"));

  writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }, { hooks: [{ type: "command", command: "npx -y @open-pets/cli@old hook --openpets-managed" }] }] } }), "utf8");
  installProjectLocalHooks(project, "npx -y @open-pets/cli@1.2.3 hook --openpets-managed --project-local --pet fixer");
  const updated = JSON.parse(readFileSync(settingsPath, "utf8")) as { readonly hooks?: Record<string, Array<{ readonly hooks: Array<{ readonly command: string; readonly timeout?: number }> }>> };
  const stopCommands = updated.hooks?.Stop?.flatMap((entry) => entry.hooks.map((hook) => hook.command)) ?? [];
  assert.ok(stopCommands.includes("echo keep"));
  assert.equal(stopCommands.some((command) => command.includes("@old")), false);
  assert.ok(stopCommands.some((command) => command.includes("--project-local --pet fixer")));
  assert.equal(updated.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.timeout, 10);

  const badSettingsProject = join(dir, "bad-settings-project");
  mkdirSync(join(badSettingsProject, ".claude"), { recursive: true });
  mkdirSync(join(badSettingsProject, ".claude", "settings.local.json"));
  assert.throws(() => assertSafeProjectHookPath(badSettingsProject));

  const malformedHooksProject = join(dir, "malformed-hooks-project");
  mkdirSync(join(malformedHooksProject, ".claude"), { recursive: true });
  writeFileSync(join(malformedHooksProject, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: { bad: true } } }), "utf8");
  assert.throws(() => installProjectLocalHooks(malformedHooksProject, "npx -y @open-pets/cli@1.2.3 hook --openpets-managed --project-local --pet fixer"));

  const symlinkProject = join(dir, "symlink-project");
  const outside = join(dir, "outside-claude");
  mkdirSync(symlinkProject);
  mkdirSync(outside);
  createDirectorySymlink(outside, join(symlinkProject, ".claude"));
  assert.throws(() => assertSafeProjectHookPath(symlinkProject));

  const binDir = join(dir, "bin");
  const logPath = join(dir, "claude-log.json");
  mkdirSync(binDir);
  const fakeClaudeScript = join(binDir, "claude.cjs");
  writeFileSync(fakeClaudeScript, `const fs = require('fs'); let log = []; try { log = JSON.parse(fs.readFileSync(${JSON.stringify(logPath)}, 'utf8')); } catch {} log.push({ cwd: process.cwd(), argv: process.argv.slice(2) }); fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(log)); process.exit(0);\n`, "utf8");
  const fakeClaude = join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  writeFileSync(fakeClaude, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "%~dp0claude.cjs" %*\r\n` : `#!/usr/bin/env node\nrequire('./claude.cjs');\n`, "utf8");
  chmodSync(fakeClaude, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
  if (process.platform !== "win32") {
    try {
      runClaudeMcpAddJson(project, { type: "stdio", command: "npx", args: ["-y", "@open-pets/cli@1.2.3", "mcp", "--pet", "fixer"], env: {} }, true);
      const claudeLog = JSON.parse(readFileSync(logPath, "utf8")) as Array<{ readonly cwd: string; readonly argv: readonly string[] }>;
      assert.equal(claudeLog.at(-1)?.cwd, realpathSync(project));
      assert.deepEqual(claudeLog.at(-2)?.argv, ["mcp", "remove", "openpets", "--scope", "local"]);
      assert.deepEqual(claudeLog.at(-1)?.argv.slice(0, 3), ["mcp", "add-json", "openpets"]);
      const loggedMcpJson = JSON.parse(claudeLog.at(-1)?.argv[3] ?? "{}") as { readonly command?: string; readonly args?: readonly string[]; readonly env?: Record<string, unknown> };
      assert.equal(loggedMcpJson.command, "npx");
      assert.deepEqual(loggedMcpJson.args, ["-y", "@open-pets/cli@1.2.3", "mcp", "--pet", "fixer"]);
      assert.deepEqual(loggedMcpJson.env, {});
      assert.equal(claudeLog.at(-1)?.argv.at(-2), "--scope");
      assert.equal(claudeLog.at(-1)?.argv.at(-1), "local");
    } finally {
      process.env.PATH = oldPath;
    }
  } else {
    process.env.PATH = oldPath;
  }

  const cliBinLink = join(binDir, "openpets");
  if (createFileSymlinkIfSupported(cliEntryPath, cliBinLink)) {
    const symlinkedHelp = spawnSync(process.execPath, [cliBinLink, "--help"], { encoding: "utf8" });
    assert.equal(symlinkedHelp.status, 0);
    assert.match(symlinkedHelp.stdout, /Usage:/);
  }

  const opencodeProject = join(dir, "opencode-project");
  mkdirSync(opencodeProject);
  await configureProject({ product: "openpets", agent: "opencode", petId: "fixer", cwd: opencodeProject, yes: true, force: false, localDev: false });
  const opencodeConfigPath = join(opencodeProject, ".opencode", "opencode.jsonc");
  const opencodeInstructionPath = join(opencodeProject, ".opencode", "openpets.md");
  const opencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, "utf8")) as { readonly mcp?: Record<string, { readonly command?: readonly string[] }>; readonly instructions?: readonly string[]; readonly plugin?: readonly unknown[] };
  assert.deepEqual(opencodeConfig.mcp?.openpets?.command, ["npx", "-y", `@open-pets/cli@${packageVersion}`, "mcp", "--product", "openpets", "--pet", "fixer"]);
  assert.deepEqual(opencodeConfig.instructions, [".opencode/openpets.md"]);
  assert.deepEqual(opencodeConfig.plugin, [[`@open-pets/opencode@${packageVersion}`, { product: "openpets", pet: "fixer" }]]);
  assert.match(readFileSync(opencodeInstructionPath, "utf8"), /OPENPETS:START/);
  await configureProject({ product: "openpets", agent: "opencode", petId: "fixer", cwd: opencodeProject, yes: true, force: false, localDev: false });
  const opencodeConfigAgain = readFileSync(opencodeConfigPath, "utf8");
  assert.equal((opencodeConfigAgain.match(/@open-pets\/opencode/g) ?? []).length, 1);

  const existingTopLevel = join(dir, "opencode-existing-top");
  mkdirSync(existingTopLevel);
  writeFileSync(join(existingTopLevel, "opencode.json"), JSON.stringify({ theme: "x", mcp: { other: { type: "local", command: ["other"] } }, plugin: ["other-plugin"], instructions: ["README.md"] }, null, 2), "utf8");
  await configureProject({ product: "openpets", agent: "opencode", petId: "fixer", cwd: existingTopLevel, yes: true, force: false, localDev: true });
  const existingConfig = JSON.parse(readFileSync(join(existingTopLevel, "opencode.json"), "utf8")) as { readonly theme?: string; readonly mcp?: Record<string, { readonly command?: readonly string[] }>; readonly plugin?: readonly unknown[]; readonly instructions?: readonly string[] };
  assert.equal(existingConfig.theme, "x");
  assert.deepEqual(existingConfig.mcp?.other?.command, ["other"]);
  assert.equal(existingConfig.mcp?.openpets?.command?.[0], "node");
  assert.ok(existingConfig.instructions?.includes("README.md"));
  assert.ok(existingConfig.instructions?.includes(".opencode/openpets.md"));
  assert.ok(existingConfig.plugin?.includes("other-plugin"));

  const lowerOwnerProject = join(dir, "opencode-lower-owner");
  mkdirSync(join(lowerOwnerProject, ".opencode"), { recursive: true });
  writeFileSync(join(lowerOwnerProject, "opencode.json"), JSON.stringify({ theme: "top" }, null, 2), "utf8");
  writeFileSync(join(lowerOwnerProject, ".opencode", "opencode.jsonc"), JSON.stringify({ mcp: { openpets: { type: "local", command: ["npx", "-y", "@open-pets/cli@0.0.1", "mcp", "--pet", "helper"], enabled: true } } }, null, 2), "utf8");
  await configureProject({ product: "openpets", agent: "opencode", petId: "fixer", cwd: lowerOwnerProject, yes: true, force: false, localDev: false });
  const lowerTop = readFileSync(join(lowerOwnerProject, "opencode.json"), "utf8");
  const lowerOwned = JSON.parse(readFileSync(join(lowerOwnerProject, ".opencode", "opencode.jsonc"), "utf8")) as { readonly mcp?: Record<string, { readonly command?: readonly string[] }> };
  assert.equal(lowerTop.includes("@open-pets/cli"), false);
  assert.deepEqual(lowerOwned.mcp?.openpets?.command, ["npx", "-y", `@open-pets/cli@${packageVersion}`, "mcp", "--product", "openpets", "--pet", "fixer"]);

  const customProject = join(dir, "opencode-custom");
  mkdirSync(customProject);
  writeFileSync(join(customProject, "opencode.json"), JSON.stringify({ mcp: { openpets: { type: "local", command: ["my-openpets-wrapper"] } } }), "utf8");
  await assert.rejects(() => configureProject({ product: "openpets", agent: "opencode", petId: "fixer", cwd: customProject, yes: true, force: false, localDev: false }));
  assert.equal(readFileSync(join(customProject, "opencode.json"), "utf8").includes("@open-pets/cli"), false);

  const instructionProject = join(dir, "opencode-instruction");
  mkdirSync(join(instructionProject, ".opencode"), { recursive: true });
  writeFileSync(join(instructionProject, ".opencode", "openpets.md"), "User text\n", "utf8");
  await configureProject({ product: "openpets", agent: "opencode", petId: "fixer", cwd: instructionProject, yes: true, force: false, localDev: false });
  const instructionText = readFileSync(join(instructionProject, ".opencode", "openpets.md"), "utf8");
  assert.match(instructionText, /User text/);
  assert.match(instructionText, /OPENPETS:START/);

  const symlinkOpenCodeProject = join(dir, "opencode-symlink");
  const outsideOpenCode = join(dir, "outside-opencode");
  mkdirSync(symlinkOpenCodeProject);
  mkdirSync(outsideOpenCode);
  writeFileSync(join(outsideOpenCode, "opencode.jsonc"), "{}\n", "utf8");
  writeFileSync(join(outsideOpenCode, "openpets.md"), "outside\n", "utf8");
  createDirectorySymlink(outsideOpenCode, join(symlinkOpenCodeProject, ".opencode"));
  await assert.rejects(() => configureProject({ product: "openpets", agent: "opencode", petId: "fixer", cwd: symlinkOpenCodeProject, yes: true, force: false, localDev: false }));

  const cursorProject = join(dir, "cursor-project");
  mkdirSync(cursorProject);
  await configureProject({ product: "openpets", agent: "cursor", petId: "fixer", cwd: cursorProject, yes: true, force: false, localDev: false });
  const cursorConfigPath = join(cursorProject, ".cursor", "mcp.json");
  const cursorConfig = JSON.parse(readFileSync(cursorConfigPath, "utf8")) as { readonly mcpServers?: Record<string, { readonly command?: string; readonly args?: readonly string[] }> };
  assert.equal(cursorConfig.mcpServers?.openpets?.command, "npx");
  assert.deepEqual(cursorConfig.mcpServers?.openpets?.args, ["-y", `@open-pets/mcp@${packageVersion}`, "--product", "openpets", "--pet", "fixer"]);
  assert.equal(readFileSync(cursorConfigPath, "utf8").includes("@open-pets/cli"), false);

  const cursorExistingProject = join(dir, "cursor-existing");
  mkdirSync(join(cursorExistingProject, ".cursor"), { recursive: true });
  writeFileSync(join(cursorExistingProject, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { type: "stdio", command: "other", args: ["--token=hidden"], env: { SECRET: "hidden" } } }, topLevel: "keep" }, null, 2), "utf8");
  const originalStdoutWrite = process.stdout.write;
  let cursorOutput = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { cursorOutput += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    await configureProject({ product: "openpets", agent: "cursor", petId: "helper", cwd: cursorExistingProject, yes: true, force: false, localDev: false });
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assert.equal(cursorOutput.includes("hidden"), false);
  const cursorExistingConfig = JSON.parse(readFileSync(join(cursorExistingProject, ".cursor", "mcp.json"), "utf8")) as { readonly mcpServers?: Record<string, { readonly command?: string; readonly args?: readonly string[]; readonly env?: unknown }>; readonly topLevel?: string };
  assert.deepEqual(cursorExistingConfig.mcpServers?.other?.args, ["--token=hidden"]);
  assert.deepEqual(cursorExistingConfig.mcpServers?.other?.env, { SECRET: "hidden" });
  assert.equal(cursorExistingConfig.topLevel, "keep");
  assert.deepEqual(cursorExistingConfig.mcpServers?.openpets?.args, ["-y", `@open-pets/mcp@${packageVersion}`, "--product", "openpets", "--pet", "helper"]);

  const cursorConflictProject = join(dir, "cursor-conflict");
  mkdirSync(join(cursorConflictProject, ".cursor"), { recursive: true });
  writeFileSync(join(cursorConflictProject, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { openpets: { type: "stdio", command: "custom", args: [] }, other: { type: "stdio", command: "other", args: [] } } }, null, 2), "utf8");
  await assert.rejects(() => configureProject({ product: "openpets", agent: "cursor", petId: "fixer", cwd: cursorConflictProject, yes: true, force: false, localDev: false }));
  await configureProject({ product: "openpets", agent: "cursor", petId: "fixer", cwd: cursorConflictProject, yes: true, force: true, localDev: false });
  const cursorReplaced = JSON.parse(readFileSync(join(cursorConflictProject, ".cursor", "mcp.json"), "utf8")) as { readonly mcpServers?: Record<string, { readonly command?: string; readonly args?: readonly string[] }> };
  assert.equal(cursorReplaced.mcpServers?.other?.command, "other");
  assert.deepEqual(cursorReplaced.mcpServers?.openpets?.args, ["-y", `@open-pets/mcp@${packageVersion}`, "--product", "openpets", "--pet", "fixer"]);

  const cursorRulesOnlyProject = join(dir, "cursor-rules-only");
  mkdirSync(cursorRulesOnlyProject);
  await configureProject({ product: "openpets", agent: "cursor", cwd: cursorRulesOnlyProject, yes: true, force: false, localDev: false, cursorRulesMode: "only" });
  const cursorRulesPath = join(cursorRulesOnlyProject, ".cursor", "rules", "openpets.mdc");
  const cursorRulesContent = readFileSync(cursorRulesPath, "utf8");
  assert.match(cursorRulesContent, /OPENPETS:CURSOR_RULES:START/);
  assert.match(cursorRulesContent, /openpets_say/);
  assert.doesNotMatch(cursorRulesContent, /alwaysApply:\s*true/);
  assert.equal(existsSync(join(cursorRulesOnlyProject, ".cursor", "mcp.json")), false);

  await configureProject({ product: "openpets", agent: "cursor", cwd: cursorRulesOnlyProject, yes: true, force: false, localDev: false, cursorRulesMode: "remove" });
  assert.equal(existsSync(cursorRulesPath), false);
  assert.equal(existsSync(join(cursorRulesOnlyProject, ".cursor", "rules")), true);

  const cursorWithRulesConflictProject = join(dir, "cursor-with-rules-conflict");
  mkdirSync(join(cursorWithRulesConflictProject, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(cursorWithRulesConflictProject, ".cursor", "rules", "openpets.mdc"), "User rule SECRET=hidden\n", "utf8");
  await assert.rejects(() => configureProject({ product: "openpets", agent: "cursor", petId: "fixer", cwd: cursorWithRulesConflictProject, yes: true, force: false, localDev: false, cursorRulesMode: "with" }));
  assert.equal(existsSync(join(cursorWithRulesConflictProject, ".cursor", "mcp.json")), false);
  assert.equal(readFileSync(join(cursorWithRulesConflictProject, ".cursor", "rules", "openpets.mdc"), "utf8"), "User rule SECRET=hidden\n");

  let cursorWithRulesOutput = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { cursorWithRulesOutput += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    await configureProject({ product: "openpets", agent: "cursor", petId: "fixer", cwd: cursorWithRulesConflictProject, yes: true, force: true, localDev: false, cursorRulesMode: "with" });
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assert.match(cursorWithRulesOutput, /Rules backup:/);
  assert.equal(cursorWithRulesOutput.includes("hidden"), false);
  const cursorWithRulesConfig = JSON.parse(readFileSync(join(cursorWithRulesConflictProject, ".cursor", "mcp.json"), "utf8")) as { readonly mcpServers?: Record<string, { readonly args?: readonly string[] }> };
  assert.deepEqual(cursorWithRulesConfig.mcpServers?.openpets?.args, ["-y", `@open-pets/mcp@${packageVersion}`, "--product", "openpets", "--pet", "fixer"]);
  assert.match(readFileSync(join(cursorWithRulesConflictProject, ".cursor", "rules", "openpets.mdc"), "utf8"), /OPENPETS:CURSOR_RULES:START/);
  const cursorRulesBackups = readdirSync(join(cursorWithRulesConflictProject, ".cursor", "rules")).filter((name) => name.includes("openpets-backup"));
  assert.equal(cursorRulesBackups.length, 1);
  assert.equal(readFileSync(join(cursorWithRulesConflictProject, ".cursor", "rules", cursorRulesBackups[0]!), "utf8"), "User rule SECRET=hidden\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

async function captureDoctorJson(cwd: string): Promise<Record<string, unknown>> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => { captured += typeof chunk === "string" ? chunk : String(chunk); return true; }) as typeof process.stdout.write;
  try {
    await runDoctor({ product: "openpets", cwd, json: true });
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(captured) as Record<string, unknown>;
}

const doctorInstalledProject = mkdtempSync(join(tmpdir(), "openpets-doctor-installed-"));
mkdirSync(join(doctorInstalledProject, ".cursor"), { recursive: true });
writeFileSync(
  join(doctorInstalledProject, ".cursor", "mcp.json"),
  JSON.stringify({ mcpServers: { openpets: { type: "stdio", command: "npx", args: ["-y", `@open-pets/mcp@${packageVersion}`] } } }, null, 2),
  "utf8"
);
const doctorInstalledReport = await captureDoctorJson(doctorInstalledProject);
assert.equal((doctorInstalledReport.cursor as { status?: string }).status, "installed");
rmSync(doctorInstalledProject, { recursive: true, force: true });

const doctorMissingProject = mkdtempSync(join(tmpdir(), "openpets-doctor-missing-"));
const doctorMissingReport = await captureDoctorJson(doctorMissingProject);
assert.equal((doctorMissingReport.cursor as { status?: string }).status, "missing");
rmSync(doctorMissingProject, { recursive: true, force: true });

const invalidHook = spawnSync(process.execPath, [cliEntryPath, "hook", "--openpets-managed", "--pet", "bad/pet"], { input: JSON.stringify({ hook_event_name: "Notification" }), encoding: "utf8" });
assert.equal(invalidHook.status, 1);
const missingPetHook = spawnSync(process.execPath, [cliEntryPath, "hook", "--openpets-managed", "--pet"], { input: JSON.stringify({ hook_event_name: "Notification" }), encoding: "utf8" });
assert.equal(missingPetHook.status, 1);

for (const args of [["--help"], ["-h"], ["status", "--help"], ["doctor", "--help"], ["pets", "--help"], ["react", "--help"], ["say", "--help"], ["install", "--help"], ["configure", "--help"], ["configure", "-h"], ["plugin", "--help"], ["plugin", "new", "--help"], ["mcp", "--help"], ["hook", "--help"]]) {
  const help = spawnSync(process.execPath, [cliEntryPath, ...args], { encoding: "utf8" });
  assert.equal(help.status, 0, `help command failed: ${args.join(" ")}\n${help.stderr}`);
  assert.match(help.stdout, /Usage:/);
}

const doctorHelp = spawnSync(process.execPath, [cliEntryPath, "doctor", "--help"], { encoding: "utf8" });
assert.equal(doctorHelp.status, 0);
assert.match(doctorHelp.stdout, /doctor/);

console.error("CLI contract validation passed.");

function createFileSymlinkIfSupported(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  }
}

function createDirectorySymlink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}
