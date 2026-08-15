import { createOpenPetsClient, targetProducts, type TargetProduct } from "./index.js";
import { validateReaction, type OpenPetsReaction } from "./protocol.js";

const { product, operands } = parseArgs(process.argv.slice(2));
const client = createOpenPetsClient({ target: product });
const [command = "status", first, second] = operands;

try {
  const result = command === "hello"
    ? await client.hello()
    : command === "status"
      ? await client.status()
      : command === "react"
        ? await client.react(validateReaction(first ?? "idle"))
        : command === "say"
          ? await client.say(first ?? "Working on it", second ? { reaction: validateReaction(second) as OpenPetsReaction } : undefined)
          : command === "invalid-token"
            ? await runInvalidTokenCheck(product)
            : await client.status();

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function runInvalidTokenCheck(product: TargetProduct): Promise<unknown> {
  const { readDiscoveryFile, sendRequest } = await import("./index.js");
  const discovery = readDiscoveryFile(product);
  return sendRequest({ ...discovery, token: "invalid-token-value" }, "hello", {});
}

function parseArgs(args: string[]): { product: TargetProduct; operands: string[] } {
  const productFlag = args.indexOf("--product");
  const product = productFlag >= 0 ? args[productFlag + 1] : undefined;
  if (!targetProducts.includes(product as TargetProduct)) {
    throw new Error("Usage: pnpm smoke --product <brainpet|openpets> [status|hello|react|say|invalid-token]");
  }
  return {
    product: product as TargetProduct,
    operands: args.filter((_value, index) => index !== productFlag && index !== productFlag + 1),
  };
}
