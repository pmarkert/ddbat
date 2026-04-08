import { createReadStream } from "fs";
import { Readable } from "stream";

import { getErrorMessage } from "../error.js";
import { JsonFormat, openOutput, streamItems } from "../json-stream.js";
import { createProgressRenderer } from "../progress.js";
import type { DdbatItem } from "../transform-types.js";

export interface StreamCommandOptions {
  input?: string;
  output?: string;
  format?: JsonFormat;
  progress?: boolean;
}

type Callable = (...args: never[]) => unknown;

export type ItemProcessor = (item: DdbatItem, index: number) => Promise<DdbatItem[]>;

export async function runItemProcessor(
  options: StreamCommandOptions,
  processor: ItemProcessor,
  summaryVerb: string
): Promise<void> {
  const outputFile = options.output ?? "-";
  const outputFormat: JsonFormat = options.format === "json" ? "json" : "jsonl";
  if (!options.input && process.stdin.isTTY) {
    throw new Error("No input provided. Pipe data to stdin or use --input <file>.");
  }
  const inputStream: Readable = options.input
    ? createReadStream(options.input)
    : (process.stdin as Readable);

  let totalItems = 0;
  let index = 0;
  const writer = openOutput(outputFormat, outputFile);
  const progress = createProgressRenderer(options.progress ?? !process.stdout.isTTY);

  for await (const item of streamItems(inputStream)) {
    const results = await processor(item, index++);
    for (const result of results) {
      await writer.writeItem(result);
      totalItems++;
    }
    progress.update(totalItems);
  }

  await writer.close();

  const summary =
    outputFile !== "-"
      ? `${summaryVerb} ${totalItems} items -> ${outputFile}`
      : `${summaryVerb} ${totalItems} items`;
  progress.end(summary);
}

export function createDynamicFunction<T extends Callable>(source: string, optionName: string): T {
  try {
    return new Function("item", "index", source) as T;
  } catch (err) {
    throw new Error(`Failed to parse ${optionName}: ${String(err)}`, { cause: err });
  }
}

export async function loadUserFunction<T extends Callable>(
  moduleFile: string,
  moduleKind: string,
  exportNames: string[]
): Promise<T> {
  try {
    const { resolve } = await import("path");
    const { pathToFileURL } = await import("url");
    const resolvedPath = resolve(moduleFile);
    const fileUrl = pathToFileURL(resolvedPath).href;
    const mod = await import(fileUrl);

    const candidate = [mod.default, ...exportNames.map((name) => mod[name])].find(
      (value) => typeof value === "function"
    );

    if (!candidate) {
      const namedExports = exportNames.map((name) => `'${name}'`).join(" or ");
      throw new Error(
        `${capitalize(moduleKind)} module must export a function as default or named ${namedExports}`
      );
    }

    return candidate as T;
  } catch (err) {
    if (moduleFile.endsWith(".ts")) {
      throw new Error(
        `Failed to load TypeScript ${moduleKind} module: ${getErrorMessage(
          err
        )}. Use ESM syntax, explicit relative import extensions, and only TypeScript features supported by native Node type stripping. If needed, precompile the ${moduleKind} to .js.`,
        { cause: err }
      );
    }

    throw new Error(`Failed to load ${moduleKind} module: ${getErrorMessage(err)}`, {
      cause: err,
    });
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
