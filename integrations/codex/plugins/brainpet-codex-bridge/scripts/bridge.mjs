import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";

import { selectLifecycleEvent, shouldWriteJsonResult } from "./bridge-core.mjs";
import { connectAttemptMs, getRuntimePaths, hookDeadlineMs, remainingDeadlineMs, runtimePollIntervalMs, shouldWakeRuntime, validateInstallMarker } from "./runtime-core.mjs";

const maxHookInputBytes = 8 * 1024 * 1024;
const maxIpcMessageBytes = 16 * 1024;
const hookDeadline = Date.now() + hookDeadlineMs;

let hookInput = null;
try {
  const raw = await readStdin();
  hookInput = JSON.parse(raw);
  const event = selectLifecycleEvent(hookInput);
  if (event) await sendLifecycleEvent(event, hookDeadline);
} catch {
  // BrainPet is optional. Its bridge must never interrupt or slow a Codex turn.
} finally {
  if (shouldWriteJsonResult(hookInput)) process.stdout.write("{}\n");
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxHookInputBytes) throw new Error("Hook input is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function sendLifecycleEvent(event, deadline) {
  if (remainingDeadlineMs(deadline) === 0) return;
  const paths = getRuntimePaths(process.platform, process.env, homedir());
  if (paths.explicitDiscovery) {
    const discovery = await readDiscovery(paths.explicitDiscovery);
    await sendToDiscovery(event, discovery, deadline);
    return;
  }

  const running = await readDiscoveryIfPresent(paths.brainPetDiscovery);
  if (running && await sendToDiscovery(event, running, deadline)) return;

  if (!shouldWakeRuntime(event)) return;

  const wake = paths.installMarker ? await launchInstalledRuntime(paths.installMarker) : { status: "missing" };
  if (paths.brainPetDiscovery && wake.status === "launched") {
    while (remainingDeadlineMs(deadline) > 0) {
      await delay(Math.min(runtimePollIntervalMs, remainingDeadlineMs(deadline)));
      const discovery = await readDiscoveryIfPresent(paths.brainPetDiscovery);
      if (discovery && await sendToDiscovery(event, discovery, deadline)) return;
    }
    return;
  }

  // Missing or invalid BrainPet installations fail open. A BrainPet bridge must
  // never send lifecycle activity to an OpenPets discovery endpoint.
}

async function sendToDiscovery(event, discovery, deadline) {
  const request = {
    id: randomUUID(),
    version: 1,
    token: discovery.token,
    method: "agent.activity",
    params: event,
  };
  const line = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(line, "utf8") > maxIpcMessageBytes) return false;
  return sendRequest(discovery.endpoint, request.id, line, Math.min(connectAttemptMs, remainingDeadlineMs(deadline)));
}

async function readDiscovery(path) {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > maxIpcMessageBytes) throw new Error("Invalid discovery file.");
  const value = JSON.parse(raw);
  if (!value || value.protocol !== "openpets-ipc" || value.protocolVersion !== 1 || value.product !== "brainpet" || value.appId !== "dev.brainpet.app" || typeof value.endpoint !== "string" || typeof value.token !== "string" || value.token.length < 16 || value.token.length > 256) {
    throw new Error("Invalid discovery file.");
  }
  return { endpoint: value.endpoint, token: value.token };
}

async function readDiscoveryIfPresent(path) {
  if (!path) return null;
  try { return await readDiscovery(path); } catch { return null; }
}

async function launchInstalledRuntime(markerPath) {
  let markerValidated = false;
  try {
    const markerRaw = await readFile(markerPath, "utf8");
    if (Buffer.byteLength(markerRaw, "utf8") > maxIpcMessageBytes) return { status: "invalid" };
    const marker = validateInstallMarker(JSON.parse(markerRaw), process.platform);
    markerValidated = true;
    const executable = await lstat(marker.executablePath);
    if (!executable.isFile() || executable.isSymbolicLink()) return { status: "invalid" };
    const child = spawn(marker.executablePath, [], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { status: "launched" };
  } catch (error) {
    if (markerValidated && error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      await unlink(markerPath).catch(() => undefined);
    }
    return { status: error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? "missing" : "invalid" };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sendRequest(endpoint, requestId, line, timeoutMs) {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) return resolve(false);
    const parsed = parseEndpoint(endpoint);
    const socket = parsed.kind === "tcp" ? net.createConnection({ host: parsed.host, port: parsed.port }) : net.createConnection(parsed.path);
    let settled = false;
    let response = "";
    let timer;
    const finish = (accepted = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(accepted);
    };
    timer = setTimeout(finish, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(line));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > maxIpcMessageBytes) return finish();
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(response.slice(0, newline));
        if (value?.id !== requestId || value?.ok !== true) return finish(false);
        return finish(true);
      } catch {
        // The bridge is intentionally fire-and-forget.
      }
      finish(false);
    });
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
  });
}

function parseEndpoint(endpoint) {
  if (endpoint.startsWith("tcp://")) {
    const url = new URL(endpoint);
    const port = Number(url.port);
    if (url.protocol !== "tcp:" || !isPrivateIpv4(url.hostname) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid IPC endpoint.");
    return { kind: "tcp", host: url.hostname, port };
  }
  if (process.platform === "win32" && !endpoint.startsWith("\\\\.\\pipe\\openpets-") && !endpoint.startsWith("\\\\.\\pipe\\brainpet-")) throw new Error("Invalid IPC endpoint.");
  if (process.platform !== "win32" && (!endpoint.startsWith("/") || endpoint.includes(".."))) throw new Error("Invalid IPC endpoint.");
  return { kind: "path", path: endpoint };
}

function isPrivateIpv4(host) {
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (parts[0] === 127 || parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168 || parts[0] === 169 && parts[1] === 254);
}
