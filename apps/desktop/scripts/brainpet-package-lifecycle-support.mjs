import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const maxDiscoveryBytes = 64 * 1024;

export function stageLifecycleAppImageForExtraction(artifactPath, scratch, label) {
  assertRegularFile(artifactPath, "Downloaded AppImage");
  const extractRoot = join(scratch, `appimage-${label}`);
  const stagedArtifact = join(extractRoot, basename(artifactPath));
  mkdirSync(extractRoot, { recursive: true });
  copyFileSync(artifactPath, stagedArtifact, constants.COPYFILE_EXCL);
  chmodSync(stagedArtifact, 0o755);
  assert.equal(hashFile(stagedArtifact), hashFile(artifactPath), "Staging changed the AppImage bytes.");
  return { extractRoot, stagedArtifact };
}

export function materializeLifecycleHelper(sourcePath, scratch, label, helperName, expectedSha256) {
  assertRegularFile(sourcePath, "Installed packaged helper");
  assert.equal(hashFile(sourcePath), expectedSha256, "Installed packaged helper hash does not match its package receipt.");
  const destination = join(scratch, "packaged-helpers", label, helperName);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(sourcePath, destination, constants.COPYFILE_EXCL);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
  assertRegularFile(destination, "Materialized packaged helper");
  assert.equal(hashFile(destination), expectedSha256, "Materialized packaged helper bytes changed after verification.");
  return destination;
}

export function removeOwnedLifecycleDiscovery(path, expected) {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxDiscoveryBytes, `Unsafe lifecycle discovery file: ${path}`);
  const current = JSON.parse(readFileSync(path, "utf8"));
  for (const field of ["product", "appId", "pid", "token", "endpoint"]) {
    assert.equal(current[field], expected[field], `Lifecycle discovery ownership changed before cleanup (${field}).`);
  }
  rmSync(path);
  if (process.platform !== "win32" && typeof expected.endpoint === "string" && !expected.endpoint.startsWith("tcp://")) {
    rmSync(expected.endpoint, { force: true });
  }
  return true;
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file: ${path}`);
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
