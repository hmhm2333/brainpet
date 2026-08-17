import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function createBrainPetRuntimeTree(runtimeRoot) {
  const requestedRoot = resolve(runtimeRoot);
  const rootStat = lstatSync(requestedRoot);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "BrainPet runtime root must be a regular directory.");
  const resolvedRoot = realpathSync.native(requestedRoot);
  const entries = [];
  const visit = (directory) => {
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const path = resolve(directory, child.name);
      const relativePath = toPortableRelative(resolvedRoot, path);
      const stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `BrainPet runtime tree contains a symbolic link or junction: ${relativePath}`);
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        visit(path);
      } else {
        assert.ok(stat.isFile(), `BrainPet runtime tree contains an unsupported entry: ${relativePath}`);
        entries.push({ path: relativePath, type: "file", bytes: stat.size, sha256: sha256File(path) });
      }
    }
  };
  visit(resolvedRoot);
  assert.ok(entries.some((entry) => entry.type === "file"), "BrainPet runtime tree must contain at least one file.");
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const tree = { schemaVersion: 1, entries };
  return Object.freeze({ ...tree, digest: sha256Text(JSON.stringify(tree)) });
}

export function validateBrainPetRuntimeTreeShape(tree) {
  assert.ok(tree && typeof tree === "object" && !Array.isArray(tree), "BrainPet runtime tree receipt is missing.");
  assert.equal(tree.schemaVersion, 1, "BrainPet runtime tree schema is invalid.");
  assert.ok(Array.isArray(tree.entries) && tree.entries.length > 0, "BrainPet runtime tree receipt is empty.");
  const paths = new Set();
  let previousPath = null;
  for (const entry of tree.entries) {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), "BrainPet runtime tree entry is invalid.");
    assertPortablePath(entry.path);
    assert.equal(paths.has(entry.path), false, `BrainPet runtime tree contains a duplicate path: ${entry.path}`);
    if (previousPath !== null) assert.ok(previousPath.localeCompare(entry.path, "en") <= 0, "BrainPet runtime tree entries are not sorted.");
    paths.add(entry.path);
    previousPath = entry.path;
    assert.ok(entry.type === "directory" || entry.type === "file", `BrainPet runtime tree entry has an invalid type: ${entry.path}`);
    if (entry.type === "directory") {
      assert.deepEqual(Object.keys(entry).sort(), ["path", "type"], `BrainPet runtime directory record has unexpected fields: ${entry.path}`);
    } else {
      assert.deepEqual(Object.keys(entry).sort(), ["bytes", "path", "sha256", "type"], `BrainPet runtime file record has unexpected fields: ${entry.path}`);
      assert.ok(Number.isInteger(entry.bytes) && entry.bytes >= 0, `BrainPet runtime file has an invalid size: ${entry.path}`);
      assert.match(entry.sha256 ?? "", /^[a-f0-9]{64}$/i, `BrainPet runtime file has an invalid digest: ${entry.path}`);
    }
  }
  assert.match(tree.digest ?? "", /^[a-f0-9]{64}$/i, "BrainPet runtime tree digest is invalid.");
  const { digest, ...core } = tree;
  assert.equal(digest, sha256Text(JSON.stringify(core)), "BrainPet runtime tree digest does not match its entries.");
  return tree;
}

export function validateBrainPetRuntimeTree(runtimeRoot, expectedTree) {
  validateBrainPetRuntimeTreeShape(expectedTree);
  const actual = createBrainPetRuntimeTree(runtimeRoot);
  assert.deepEqual(actual, expectedTree, "BrainPet packaged runtime tree differs from its receipt.");
  return actual;
}

function toPortableRelative(root, path) {
  const child = relative(root, path);
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), "BrainPet runtime entry escaped its root.");
  return child.replaceAll("\\", "/");
}

function assertPortablePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !isAbsolute(value), "BrainPet runtime tree path is invalid.");
  assert.equal(value.includes("\\"), false, "BrainPet runtime tree paths must use portable separators.");
  assert.equal(value.split("/").some((segment) => !segment || segment === "." || segment === ".."), false, "BrainPet runtime tree path is invalid.");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
