import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";

import { brainPetBridgeVersion, brainPetReleaseTargets } from "./generated-brainpet-distribution.js";

const pluginName = "brainpet-codex-bridge";
const marketplaceName = "brainpet";
const desiredSelector = `${pluginName}@${marketplaceName}`;
const maxConfigBytes = 2 * 1024 * 1024;
const maxJsonBytes = 256 * 1024;
const commandTimeoutMs = 15_000;

export type BrainPetAdapterBridgeStatus = "not-installed" | "installed" | "upgrade-required";
export type BrainPetAdapterStatusReason = "codex-not-found" | "codex-query-failed" | "bundle-invalid" | null;

export interface BrainPetAdapterStatus {
  readonly agent: "unavailable" | "detected";
  readonly bridge: BrainPetAdapterBridgeStatus;
  readonly installedVersion: string | null;
  readonly bundledVersion: string;
  readonly codexCliVersion: string | null;
  readonly canConnect: boolean;
  readonly reason: BrainPetAdapterStatusReason;
}

export interface BrainPetAdapterReceipt {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly operation: "install" | "upgrade" | "uninstall";
  readonly status: "succeeded" | "rolled-back" | "rollback-failed";
  readonly product: "brainpet";
  readonly provider: "codex";
  readonly bundledBridgeVersion: string;
  readonly previousSelectors: readonly string[];
  readonly installedSelector: string | null;
  readonly codexCliVersion: string;
  readonly configBackup: {
    readonly existed: boolean;
    readonly path: string | null;
    readonly sha256: string | null;
  };
  readonly rollbackApplied: boolean;
  readonly errorCode: string | null;
  readonly occurredAt: number;
}

export interface BrainPetAdapterOperationResult {
  readonly status: BrainPetAdapterStatus;
  readonly receipt: BrainPetAdapterReceipt;
}

export interface BrainPetCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type BrainPetCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
) => Promise<BrainPetCommandResult>;

export interface BrainPetAdapterManagerOptions {
  readonly userDataPath: string;
  readonly marketplaceRoot: string;
  readonly codexHome: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runCommand?: BrainPetCommandRunner;
  readonly resolveCodexExecutable?: () => Promise<string | null>;
  readonly now?: () => number;
  readonly createOperationId?: () => string;
}

interface CodexInstallation {
  readonly executable: string;
  readonly version: string;
}

interface InstalledPlugin {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
}

interface ConfiguredMarketplace {
  readonly name: string;
  readonly root: string;
}

interface ConfigBackup {
  readonly existed: boolean;
  readonly absolutePath: string | null;
  readonly relativePath: string | null;
  readonly sha256: string | null;
}

export class BrainPetAdapterOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrainPetAdapterOperationError";
  }
}

export class BrainPetAdapterManager {
  private readonly userDataPath: string;
  private readonly marketplaceRoot: string;
  private readonly codexHome: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runCommand: BrainPetCommandRunner;
  private readonly resolveExecutableOverride?: () => Promise<string | null>;
  private readonly now: () => number;
  private readonly createOperationId: () => string;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: BrainPetAdapterManagerOptions) {
    assertAbsoluteSafePath(options.userDataPath, "BrainPet user data");
    assertAbsoluteSafePath(options.marketplaceRoot, "BrainPet marketplace");
    assertAbsoluteSafePath(options.codexHome, "Codex home");
    this.userDataPath = resolve(options.userDataPath);
    this.marketplaceRoot = resolve(options.marketplaceRoot);
    this.codexHome = resolve(options.codexHome);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.environment = { ...(options.environment ?? process.env), CODEX_HOME: this.codexHome };
    this.runCommand = options.runCommand ?? runCommand;
    this.resolveExecutableOverride = options.resolveCodexExecutable;
    this.now = options.now ?? Date.now;
    this.createOperationId = options.createOperationId ?? randomUUID;
  }

  async getStatus(): Promise<BrainPetAdapterStatus> {
    let bundleValid = true;
    try {
      this.validateBundledMarketplace();
    } catch {
      bundleValid = false;
    }
    const codex = await this.detectCodex();
    if (!codex) return statusUnavailable(bundleValid ? "codex-not-found" : "bundle-invalid");
    let installed: readonly InstalledPlugin[];
    let marketplaces: readonly ConfiguredMarketplace[];
    try {
      installed = await this.listInstalledPlugins(codex.executable);
      marketplaces = await this.listMarketplaces(codex.executable);
    } catch {
      return {
        agent: "detected",
        bridge: "not-installed",
        installedVersion: null,
        bundledVersion: brainPetBridgeVersion,
        codexCliVersion: codex.version,
        canConnect: false,
        reason: bundleValid ? "codex-query-failed" : "bundle-invalid",
      };
    }
    const bridge = deriveBridgeStatus(installed, this.hasBundledMarketplace(marketplaces));
    return {
      agent: "detected",
      ...bridge,
      bundledVersion: brainPetBridgeVersion,
      codexCliVersion: codex.version,
      canConnect: bundleValid,
      reason: bundleValid ? null : "bundle-invalid",
    };
  }

  connectOrUpgrade(): Promise<BrainPetAdapterOperationResult> {
    return this.runExclusive(() => this.mutate("connect"));
  }

  uninstall(): Promise<BrainPetAdapterOperationResult> {
    return this.runExclusive(() => this.mutate("uninstall"));
  }

  private async mutate(request: "connect" | "uninstall"): Promise<BrainPetAdapterOperationResult> {
    if (request === "connect") this.validateBundledMarketplace();
    const codex = await this.detectCodex();
    if (!codex) throw new BrainPetAdapterOperationError("codex-not-found", "Codex CLI was not detected.");
    const before = await this.listInstalledPlugins(codex.executable);
    const bridgePlugins = before.filter((plugin) => plugin.name === pluginName);
    const operation: BrainPetAdapterReceipt["operation"] = request === "uninstall"
      ? "uninstall"
      : bridgePlugins.length === 0
        ? "install"
        : "upgrade";
    const operationId = sanitizeOperationId(this.createOperationId());
    const occurredAt = this.now();
    let backup: ConfigBackup | null = null;
    let mutationStarted = false;
    try {
      backup = this.backupConfig(operationId);
      mutationStarted = true;
      if (request === "connect") {
        await this.removeBrainPetConfiguration(codex.executable, bridgePlugins);
        await this.runRequired(codex.executable, ["plugin", "marketplace", "add", this.marketplaceRoot, "--json"], "marketplace-add-failed");
        await this.runRequired(codex.executable, ["plugin", "add", desiredSelector, "--json"], "plugin-add-failed");
        const [verified, marketplaces] = await Promise.all([
          this.listInstalledPlugins(codex.executable),
          this.listMarketplaces(codex.executable),
        ]);
        const derived = deriveBridgeStatus(verified, this.hasBundledMarketplace(marketplaces));
        if (derived.bridge !== "installed") throw new BrainPetAdapterOperationError("verification-failed", "Codex Bridge installation could not be verified.");
      } else {
        await this.removeBrainPetConfiguration(codex.executable, bridgePlugins);
        const verified = await this.listInstalledPlugins(codex.executable);
        if (verified.some((plugin) => plugin.name === pluginName)) throw new BrainPetAdapterOperationError("verification-failed", "Codex Bridge removal could not be verified.");
      }
      const receipt = this.writeReceipt({
        operationId,
        operation,
        status: "succeeded",
        previousSelectors: bridgePlugins.map((plugin) => plugin.pluginId),
        installedSelector: request === "connect" ? desiredSelector : null,
        codexCliVersion: codex.version,
        backup,
        rollbackApplied: false,
        errorCode: null,
        occurredAt,
      });
      return { status: await this.getStatus(), receipt };
    } catch (error) {
      const original = normalizeOperationError(error);
      let rollbackApplied = false;
      let rollbackFailed = false;
      if (backup && mutationStarted) {
        await this.cleanupFailedMutation(codex.executable).catch(() => undefined);
        try {
          this.restoreConfig(backup, operationId);
          rollbackApplied = true;
        } catch {
          rollbackFailed = true;
        }
      }
      if (backup) {
        try {
          this.writeReceipt({
            operationId,
            operation,
            status: rollbackFailed ? "rollback-failed" : "rolled-back",
            previousSelectors: bridgePlugins.map((plugin) => plugin.pluginId),
            installedSelector: null,
            codexCliVersion: codex.version,
            backup,
            rollbackApplied,
            errorCode: original.code,
            occurredAt,
          });
        } catch { /* preserve the operation/rollback error if receipt storage is unavailable */ }
      }
      if (rollbackFailed) throw new BrainPetAdapterOperationError("rollback-failed", "Codex Bridge operation failed and its config backup could not be restored.");
      throw original;
    }
  }

  private validateBundledMarketplace(): void {
    const target = brainPetReleaseTargets.find((candidate) => candidate.nodePlatform === this.platform && candidate.arch === this.arch);
    if (!target) throw new BrainPetAdapterOperationError("bundle-invalid", "This BrainPet package has no Bridge helper for the current target.");
    const marketplace = readJsonFile(join(this.marketplaceRoot, ".agents", "plugins", "marketplace.json"));
    const marketplacePlugins = isRecord(marketplace) && Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    const source = marketplacePlugins.find((entry) => isRecord(entry) && entry.name === pluginName)?.source;
    if (!isRecord(marketplace) || marketplace.name !== marketplaceName || !isRecord(source) || source.source !== "local" || source.path !== `./plugins/${pluginName}`) {
      throw new BrainPetAdapterOperationError("bundle-invalid", "The bundled BrainPet marketplace identity is invalid.");
    }
    const pluginRoot = join(this.marketplaceRoot, "plugins", pluginName);
    const manifest = readJsonFile(join(pluginRoot, ".codex-plugin", "plugin.json"));
    const contract = readJsonFile(join(pluginRoot, "brainpet.bridge.json"));
    const bundle = readJsonFile(join(this.marketplaceRoot, "brainpet-bundle.json"));
    if (!isRecord(manifest) || manifest.name !== pluginName || manifest.version !== brainPetBridgeVersion
      || !isRecord(contract) || contract.bridgeVersion !== brainPetBridgeVersion || !Array.isArray(contract.transportPriority)
      || contract.transportPriority.length !== 1 || contract.transportPriority[0] !== "native-hook"
      || !isRecord(bundle) || bundle.product !== "brainpet" || bundle.target !== target.id || bundle.bridgeVersion !== brainPetBridgeVersion
      || bundle.nodeFallbackBundled !== false || !isRecord(bundle.helper)) {
      throw new BrainPetAdapterOperationError("bundle-invalid", "The bundled BrainPet Bridge contract is invalid.");
    }
    const expectedRelativeHelper = `plugins/${pluginName}/bin/${target.id}/${target.helperName}`;
    if (bundle.helper.path !== expectedRelativeHelper || typeof bundle.helper.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(bundle.helper.sha256)) {
      throw new BrainPetAdapterOperationError("bundle-invalid", "The bundled BrainPet helper receipt is invalid.");
    }
    const helperPath = join(this.marketplaceRoot, ...expectedRelativeHelper.split("/"));
    const helper = readRegularFile(helperPath, 64 * 1024 * 1024);
    if (helper.length === 0 || createHash("sha256").update(helper).digest("hex") !== bundle.helper.sha256) {
      throw new BrainPetAdapterOperationError("bundle-invalid", "The bundled BrainPet helper does not match its receipt.");
    }
    if (existsSync(join(pluginRoot, "scripts", "bridge.mjs"))) {
      throw new BrainPetAdapterOperationError("bundle-invalid", "The packaged BrainPet Bridge contains a forbidden Node fallback.");
    }
  }

  private async detectCodex(): Promise<CodexInstallation | null> {
    const candidates = this.resolveExecutableOverride
      ? [await this.resolveExecutableOverride()].filter((value): value is string => value !== null)
      : await this.resolveCodexExecutables();
    for (const executable of candidates) {
      if (!isAbsoluteForPlatform(executable, this.platform) || /[\0\r\n]/.test(executable)) continue;
      const version = await this.runCommand(executable, ["--version"], { env: this.environment, timeoutMs: commandTimeoutMs }).catch(() => null);
      if (!version || version.code !== 0) continue;
      const match = /^codex-cli\s+([a-z0-9._+-]{1,64})\s*$/im.exec(version.stdout);
      if (match) return { executable, version: match[1] };
    }
    return null;
  }

  private async resolveCodexExecutables(): Promise<readonly string[]> {
    const locator = this.platform === "win32" ? "where.exe" : "which";
    const result = await this.runCommand(locator, ["codex"], { env: this.environment, timeoutMs: 5_000 }).catch(() => null);
    if (!result || result.code !== 0) return [];
    const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (this.platform === "win32") {
      return [...new Set(candidates.filter((candidate) => win32.isAbsolute(candidate) && /\.(?:exe|cmd)$/i.test(candidate)))]
        .sort((left, right) => Number(left.toLowerCase().endsWith(".cmd")) - Number(right.toLowerCase().endsWith(".cmd")));
    }
    return [...new Set(candidates.filter((candidate) => posix.isAbsolute(candidate)))];
  }

  private async listInstalledPlugins(executable: string): Promise<readonly InstalledPlugin[]> {
    const result = await this.runRequired(executable, ["plugin", "list", "--json"], "codex-query-failed");
    const value = parseJsonOutput(result.stdout, "Codex plugin list");
    if (!isRecord(value) || !Array.isArray(value.installed)) throw new BrainPetAdapterOperationError("codex-query-failed", "Codex returned an invalid plugin list.");
    return value.installed.flatMap((entry): InstalledPlugin[] => {
      if (!isRecord(entry) || typeof entry.pluginId !== "string" || typeof entry.name !== "string" || typeof entry.version !== "string") return [];
      if (!/^[a-z0-9._-]+@[a-z0-9._-]+$/i.test(entry.pluginId) || !/^[a-z0-9._-]+$/i.test(entry.name) || !/^[a-z0-9._+-]{1,64}$/i.test(entry.version)) return [];
      return [{ pluginId: entry.pluginId, name: entry.name, version: entry.version }];
    });
  }

  private async listMarketplaces(executable: string): Promise<readonly ConfiguredMarketplace[]> {
    const result = await this.runRequired(executable, ["plugin", "marketplace", "list", "--json"], "codex-query-failed");
    const value = parseJsonOutput(result.stdout, "Codex marketplace list");
    if (!isRecord(value) || !Array.isArray(value.marketplaces)) throw new BrainPetAdapterOperationError("codex-query-failed", "Codex returned an invalid marketplace list.");
    return value.marketplaces.flatMap((entry): ConfiguredMarketplace[] => isRecord(entry)
      && typeof entry.name === "string" && entry.name.length <= 128
      && typeof entry.root === "string" && entry.root.length <= 4096 && !/[\0\r\n]/.test(entry.root)
      ? [{ name: entry.name, root: entry.root }]
      : []);
  }

  private async removeBrainPetConfiguration(executable: string, bridgePlugins: readonly InstalledPlugin[]): Promise<void> {
    for (const plugin of bridgePlugins) {
      await this.runRequired(executable, ["plugin", "remove", plugin.pluginId, "--json"], "plugin-remove-failed");
    }
    const marketplaces = await this.listMarketplaces(executable);
    if (marketplaces.some((marketplace) => marketplace.name === marketplaceName)) {
      await this.runRequired(executable, ["plugin", "marketplace", "remove", marketplaceName, "--json"], "marketplace-remove-failed");
    }
  }

  private hasBundledMarketplace(marketplaces: readonly ConfiguredMarketplace[]): boolean {
    const configured = marketplaces.find((marketplace) => marketplace.name === marketplaceName);
    return configured ? equalPlatformPaths(configured.root, this.marketplaceRoot, this.platform) : false;
  }

  private async cleanupFailedMutation(executable: string): Promise<void> {
    const plugins = await this.listInstalledPlugins(executable).catch(() => []);
    for (const plugin of plugins.filter((candidate) => candidate.name === pluginName)) {
      await this.runCommand(executable, ["plugin", "remove", plugin.pluginId, "--json"], { env: this.environment, timeoutMs: commandTimeoutMs }).catch(() => undefined);
    }
    await this.runCommand(executable, ["plugin", "marketplace", "remove", marketplaceName, "--json"], { env: this.environment, timeoutMs: commandTimeoutMs }).catch(() => undefined);
  }

  private async runRequired(executable: string, args: readonly string[], code: string): Promise<BrainPetCommandResult> {
    const result = await this.runCommand(executable, args, { env: this.environment, timeoutMs: commandTimeoutMs });
    if (result.code !== 0) throw new BrainPetAdapterOperationError(code, `Codex command failed (${code}).`);
    return result;
  }

  private backupConfig(operationId: string): ConfigBackup {
    const configPath = join(this.codexHome, "config.toml");
    const backupsRoot = join(this.userDataPath, "adapter-backups");
    mkdirPrivate(backupsRoot);
    if (!existsSync(configPath)) return { existed: false, absolutePath: null, relativePath: null, sha256: null };
    const bytes = readRegularFile(configPath, maxConfigBytes);
    const backupPath = join(backupsRoot, `codex-config-${operationId}.toml`);
    writeImmutableFile(backupPath, bytes);
    return {
      existed: true,
      absolutePath: backupPath,
      relativePath: relative(this.userDataPath, backupPath).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  private restoreConfig(backup: ConfigBackup, operationId: string): void {
    const configPath = join(this.codexHome, "config.toml");
    mkdirPrivate(dirname(configPath));
    if (!backup.existed) {
      if (!existsSync(configPath)) return;
      assertRegularFile(configPath, maxConfigBytes);
      rmSync(configPath);
      return;
    }
    if (!backup.absolutePath || !backup.sha256) throw new Error("BrainPet config backup metadata is incomplete.");
    const bytes = readRegularFile(backup.absolutePath, maxConfigBytes);
    if (createHash("sha256").update(bytes).digest("hex") !== backup.sha256) throw new Error("BrainPet config backup integrity check failed.");
    replaceFile(configPath, bytes, operationId);
  }

  private writeReceipt(input: Omit<BrainPetAdapterReceipt, "schemaVersion" | "product" | "provider" | "bundledBridgeVersion" | "configBackup"> & { readonly backup: ConfigBackup }): BrainPetAdapterReceipt {
    const receipt: BrainPetAdapterReceipt = {
      schemaVersion: 1,
      operationId: input.operationId,
      operation: input.operation,
      status: input.status,
      product: "brainpet",
      provider: "codex",
      bundledBridgeVersion: brainPetBridgeVersion,
      previousSelectors: [...input.previousSelectors],
      installedSelector: input.installedSelector,
      codexCliVersion: input.codexCliVersion,
      configBackup: { existed: input.backup.existed, path: input.backup.relativePath, sha256: input.backup.sha256 },
      rollbackApplied: input.rollbackApplied,
      errorCode: input.errorCode,
      occurredAt: input.occurredAt,
    };
    const receiptsRoot = join(this.userDataPath, "adapter-receipts");
    mkdirPrivate(receiptsRoot);
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    writeImmutableFile(join(receiptsRoot, `codex-${input.operationId}.json`), bytes);
    replaceFile(join(receiptsRoot, "codex-latest.json"), bytes, input.operationId);
    return receipt;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function deriveBridgeStatus(installed: readonly InstalledPlugin[], marketplaceBound = true): Pick<BrainPetAdapterStatus, "bridge" | "installedVersion"> {
  const bridges = installed.filter((plugin) => plugin.name === pluginName);
  const exact = bridges.find((plugin) => plugin.pluginId === desiredSelector);
  if (bridges.length === 1 && exact?.version === brainPetBridgeVersion && marketplaceBound) return { bridge: "installed", installedVersion: exact.version };
  if (bridges.length === 0) return { bridge: "not-installed", installedVersion: null };
  return { bridge: "upgrade-required", installedVersion: exact?.version ?? bridges[0]?.version ?? null };
}

function statusUnavailable(reason: Exclude<BrainPetAdapterStatusReason, null>): BrainPetAdapterStatus {
  return { agent: "unavailable", bridge: "not-installed", installedVersion: null, bundledVersion: brainPetBridgeVersion, codexCliVersion: null, canConnect: false, reason };
}

function normalizeOperationError(error: unknown): BrainPetAdapterOperationError {
  return error instanceof BrainPetAdapterOperationError
    ? error
    : new BrainPetAdapterOperationError("operation-failed", "Codex Bridge operation failed.");
}

function sanitizeOperationId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(value)) throw new BrainPetAdapterOperationError("operation-id-invalid", "BrainPet adapter operation id is invalid.");
  return value;
}

function assertAbsoluteSafePath(value: string, label: string): void {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) throw new TypeError(`${label} path must be absolute.`);
}

function isAbsoluteForPlatform(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

function equalPlatformPaths(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const normalize = (value: string) => win32.resolve(value.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "").toLowerCase();
    return normalize(left) === normalize(right);
  }
  return posix.resolve(left).replace(/\/+$/, "") === posix.resolve(right).replace(/\/+$/, "");
}

function assertRegularFile(path: string, maxBytes: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(`Unsafe or oversized file: ${path}`);
}

function readRegularFile(path: string, maxBytes: number): Buffer {
  assertRegularFile(path, maxBytes);
  return readFileSync(path);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readRegularFile(path, maxJsonBytes).toString("utf8"));
  } catch (error) {
    if (error instanceof BrainPetAdapterOperationError) throw error;
    throw new BrainPetAdapterOperationError("bundle-invalid", `BrainPet bundle file is invalid: ${path}`);
  }
}

function parseJsonOutput(value: string, label: string): unknown {
  if (Buffer.byteLength(value, "utf8") > maxJsonBytes) throw new BrainPetAdapterOperationError("codex-query-failed", `${label} output is too large.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new BrainPetAdapterOperationError("codex-query-failed", `${label} output is invalid.`);
  }
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* best effort on Windows */ }
}

function writeImmutableFile(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
}

function replaceFile(path: string, bytes: Buffer, operationId: string): void {
  mkdirPrivate(dirname(path));
  const temporaryPath = `${path}.${operationId}.tmp`;
  const displacedPath = `${path}.${operationId}.previous`;
  writeImmutableFile(temporaryPath, bytes);
  let displaced = false;
  try {
    if (existsSync(path)) {
      assertRegularFile(path, Math.max(maxConfigBytes, bytes.length + 1));
      renameSync(path, displacedPath);
      displaced = true;
    }
    renameSync(temporaryPath, path);
    if (displaced) rmSync(displacedPath);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
    if (displaced && !existsSync(path) && existsSync(displacedPath)) renameSync(displacedPath, path);
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
}

function runCommand(executable: string, args: readonly string[], options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number }): Promise<BrainPetCommandResult> {
  return new Promise((resolvePromise) => {
    let command = executable;
    let commandArgs = [...args];
    if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
      const commandInterpreter = process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      if (!win32.isAbsolute(commandInterpreter) || !/cmd\.exe$/i.test(commandInterpreter) || !isSafeCmdToken(executable) || !args.every(isSafeCmdToken)) {
        resolvePromise({ code: 1, stdout: "", stderr: "BrainPet rejected an unsafe Codex CLI shim path." });
        return;
      }
      command = commandInterpreter;
      commandArgs = ["/d", "/c", executable, ...args];
    }
    execFile(command, commandArgs, { encoding: "utf8", env: options.env, timeout: options.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const errorCode = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
        ? (error as NodeJS.ErrnoException & { code: number }).code
        : error
          ? 1
          : 0;
      resolvePromise({ code: errorCode, stdout, stderr });
    });
  });
}

function isSafeCmdToken(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\0\r\n"%!^&|<>]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
