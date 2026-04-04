import { Command } from "commander";
import { createReadStream } from "fs";
import { Readable } from "stream";

import { wrapCommandHandler } from "../command-wrapper.js";
import { getErrorMessage } from "../error.js";
import { JsonFormat, openOutput, streamItems } from "../json-stream.js";
import { createProgressRenderer } from "../progress.js";
import type { DdbatItem, TransformFn, TransformResult } from "../transform-types.js";

interface Options {
  input?: string;
  inputFormat?: JsonFormat;
  transform?: string;
  script?: string;
  output?: string;
  format?: JsonFormat;
  progress?: boolean;
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
  const { input: inputFile, inputFormat, transform: transformFile, script, output } = options;
  const outputFile = output ?? "-";
  const outputFormat: JsonFormat = options.format === "json" ? "json" : "jsonl";

  if (!transformFile && !script) {
    throw new Error("Provide either --transform <file> or --script <js>");
  }
  if (transformFile && script) {
    throw new Error("--transform and --script are mutually exclusive. Provide only one.");
  }

  const inputStream: Readable = inputFile
    ? createReadStream(inputFile)
    : (process.stdin as Readable);

  const transformFn = script
    ? createInlineTransform(script)
    : await loadTransformModule(transformFile!);

  let totalItems = 0;
  const writer = openOutput(outputFormat, outputFile);
  let index = 0;
  const progress = createProgressRenderer(options.progress ?? !process.stdout.isTTY);

  for await (const item of streamItems(inputStream, inputFormat)) {
    const results = await applyTransformToItem(item, index++, transformFn);
    for (const result of results) {
      await writer.writeItem(result);
      totalItems++;
    }
    progress.update(totalItems);
  }

  await writer.close();

  const summary =
    outputFile && outputFile !== "-"
      ? `Transformed ${totalItems} items -> ${outputFile}`
      : `Transformed ${totalItems} items`;
  progress.end(summary);
}

function createInlineTransform(script: string): TransformFn {
  try {
    return new Function("item", "index", script) as TransformFn;
  } catch (err) {
    throw new Error(`Failed to parse --script: ${String(err)}`, { cause: err });
  }
}

async function loadTransformModule(transformFile: string): Promise<TransformFn> {
  // Load the transform via native Node module loading.
  // .ts files rely on Node's built-in TypeScript support when available.
  try {
    // Resolve transform file to an absolute path and import via file:// URL
    const { resolve } = await import("path");
    const { pathToFileURL } = await import("url");
    const resolvedPath = resolve(transformFile);
    const fileUrl = pathToFileURL(resolvedPath).href;
    const mod = await import(fileUrl);

    // Prefer default export then named export 'transform' or 'default'
    const transformFn = (mod.default || mod.transform || mod.apply) as TransformFn;

    if (!transformFn || typeof transformFn !== "function") {
      throw new Error("Transform module must export a function as default or named 'transform'");
    }

    return transformFn;
  } catch (err) {
    if (transformFile.endsWith(".ts")) {
      throw new Error(
        `Failed to load TypeScript transform module: ${getErrorMessage(
          err
        )}. Use ESM syntax, explicit relative import extensions, and only TypeScript features supported by native Node type stripping. If needed, precompile the transform to .js.`,
        { cause: err }
      );
    }

    throw new Error(`Failed to load transform module: ${getErrorMessage(err)}`, { cause: err });
  }
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
