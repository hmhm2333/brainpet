#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOpenPetsClient,
  OpenPetsClientError,
  targetProducts,
  type TargetProduct,
} from "@open-pets/client";

export interface InstallPetOptions {
  readonly petId: string;
  readonly product: TargetProduct;
}

export interface InstallPetResult {
  readonly petId: string;
  readonly displayName: string;
  readonly via: "host";
  readonly product: TargetProduct;
}

export interface InstallPetArgs {
  readonly petId: string;
  readonly product?: TargetProduct;
  readonly help: boolean;
}

/**
 * Installs through the selected running host. The release CLI deliberately has
 * no catalog downloader or state-file writer: the host owns validation,
 * locking, migration, extraction, and atomic persistence.
 */
export async function installPet(options: InstallPetOptions): Promise<InstallPetResult> {
  const petId = validatePetId(options.petId);
  const product = validateProduct(options.product);
  try {
    const result = await createOpenPetsClient({ target: product, responseTimeoutMs: 60_000 }).installPet(petId);
    return { petId: result.petId, displayName: result.displayName, via: "host", product };
  } catch (error) {
    if (error instanceof OpenPetsClientError && ["unavailable", "connect_timeout", "connection_closed"].includes(error.code)) {
      throw new Error(`The ${product} host is not available. Start ${product} and retry; install-pet never writes application state offline.`);
    }
    if (error instanceof OpenPetsClientError && ["unknown_method", "invalid_version"].includes(error.code)) {
      throw new Error(`The running ${product} host does not support versioned pet installation. Update the host and retry.`);
    }
    throw error;
  }
}

export function parseArgs(args: readonly string[]): InstallPetArgs {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { petId: "", help: true };

  let product: TargetProduct | undefined;
  let petId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--product") {
      product = validateProduct(args[index + 1]);
      index += 1;
    } else if (arg.startsWith("--product=")) {
      product = validateProduct(arg.slice("--product=".length));
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown install-pet option: ${arg}`);
    } else if (petId === undefined) {
      petId = validatePetId(arg);
    } else {
      throw new Error("Usage: install-pet --product <brainpet|openpets> <pet-id>");
    }
  }
  if (!product) throw new Error("Missing required --product <brainpet|openpets> target.");
  if (!petId) throw new Error("Missing pet id.");
  return { petId, product, help: false };
}

export function validatePetId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || value === "builtin") {
    throw new Error(`Invalid OpenPets pet id: ${value}`);
  }
  return value;
}

export function validateProduct(value: unknown): TargetProduct {
  if (!targetProducts.includes(value as TargetProduct)) {
    throw new Error(`Invalid product target: ${typeof value === "string" ? value : "missing"}. Expected brainpet or openpets.`);
  }
  return value as TargetProduct;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }
  if (!parsed.product) throw new Error("Missing product target.");
  const result = await installPet({ petId: parsed.petId, product: parsed.product });
  process.stdout.write(`Installed ${result.product} pet through the running host: ${result.displayName} (${result.petId})\n`);
}

function printUsage(): void {
  process.stdout.write("Usage:\n  install-pet --product <brainpet|openpets> <pet-id>\n\nInstalls through the explicitly selected running host. No application state is written while the host is offline.\nExample:\n  npx -y install-pet --product brainpet review-owl\n");
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}
