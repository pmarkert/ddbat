import { Command } from "commander";

import { wrapCommandHandler } from "../command-wrapper.js";
import type { DdbatItem, TransformFn, TransformResult } from "../transform-types.js";
import {
  createDynamicFunction,
  loadUserFunction,
  runItemProcessor,
  type StreamCommandOptions,
} from "./stream-command-support.js";

interface Options extends StreamCommandOptions {
  transform?: string;
  script?: string;
}

export function setup(program: Command) {
  program
    .command("transform")
    .description(
      "Apply a user-provided JavaScript or TypeScript transform to every item in a JSON file."
    )
    .addHelpText(
      "after",
      [
        "\nProvide either --transform (a module file) or --script (inline JS body).",
        "",
        "--transform module must export a default function or named 'transform':",
        "  export default (item, index) => ({ ...item, migratedAt: new Date().toISOString() });",
        "",
        "--script receives the body of a function with 'item' and 'index' in scope:",
        "  Return the item to keep it, return null/undefined to drop it, or return a new object.",
        "",
        "Examples (inline --script):",
        "  # Add a field",
        "  ddbat transform --script 'return { ...item, env: \"prod\" }'",
        "",
        "  # Filter - return null to exclude the item",
        "  ddbat transform --script 'if (!item.active) return null; return item'",
        "",
        "  # Remove a sensitive field",
        "  ddbat transform --script 'const { ssn, ...safe } = item; return safe'",
        "",
        "  # Multiline (open quote, press Enter, close quote)",
        "  ddbat transform --script '",
        "    const { ssn, creditCard, ...safe } = item;",
        "    safe.migratedAt = new Date().toISOString();",
        "    return safe",
        "  '",
        "",
        "Examples (--transform module file):",
        "  ddbat transform --transform ./migrations/add-field.js --input data.json",
        "  cat data.json | ddbat transform --transform ./migrations/add-field.js",
        "",
        "TypeScript transform files are loaded directly by Node.",
        "Use modern ESM syntax and avoid TS features that require code generation",
        "(for example enums, parameter properties, decorators, and tsconfig path aliases).",
        "",
        "Chaining:",
        "  ddbat export --table users",
        "    | ddbat transform --script 'const { ssn, ...s } = item; return s'",
        "    | ddbat transform --transform ./migrations/normalize.js",
        "    | ddbat import --table users-clean",
        "",
      ].join("\n")
    )
    .option("-i, --input [file]", "Input file (omit to read from stdin)")
    .option(
      "--input-format <format>",
      "Input format: jsonl (JSON lines) or json (JSON array) — auto-detected when omitted"
    )
    .option("-x, --transform <file>", "Path to transform module file")
    .option("-s, --script <js>", "Inline JS function body with 'item' and 'index' in scope")
    .option("-o, --output [file]", "Output file path (defaults to stdout)")
    .option(
      "--format <format>",
      "Output format: jsonl (JSON lines, default) or json (JSON array)",
      "jsonl"
    )
    .option("--no-progress", "No animated progress indicator")
    .action(wrapCommandHandler(transformCommand));
}

async function transformCommand(options: Options = {}) {
  const { transform: transformFile, script } = options;
  const transformModeCount = [transformFile, script].filter(Boolean).length;

  if (transformModeCount === 0) {
    throw new Error("Provide either --transform <file> or --script <js>");
  }
  if (transformModeCount > 1) {
    throw new Error("--transform and --script are mutually exclusive. Provide only one.");
  }

  const transformFn = script
    ? createInlineTransform(script)
    : await loadTransformModule(transformFile!);

  await runItemProcessor(
    options,
    (item, index) => applyTransformToItem(item, index, transformFn),
    "Transformed"
  );
}

function createInlineTransform(script: string): TransformFn {
  return createDynamicFunction<TransformFn>(script, "--script");
}

async function loadTransformModule(transformFile: string): Promise<TransformFn> {
  return loadUserFunction<TransformFn>(transformFile, "transform", ["transform", "apply"]);
}

/** Apply the transform function to one input item, returning an array of output items. */
async function applyTransformToItem(
  item: DdbatItem,
  index: number,
  transformFn: TransformFn
): Promise<DdbatItem[]> {
  let res: TransformResult;
  try {
    res = await transformFn(item, index);
  } catch (err) {
    throw new Error(`Transform failed at item #${index + 1}: ${String(err)}`, { cause: err });
  }

  if (res == null) return [];
  if (Array.isArray(res)) return res;
  return [res];
}
