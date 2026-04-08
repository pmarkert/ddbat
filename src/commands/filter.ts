import { Command } from "commander";

import { wrapCommandHandler } from "../command-wrapper.js";
import type { DdbatItem } from "../transform-types.js";
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

type FilterFn = (item: DdbatItem, index: number) => boolean | Promise<boolean>;

export function setup(program: Command) {
  program
    .command("filter")
    .description(
      "Apply a user-provided JavaScript or TypeScript predicate to every item in a JSON file."
    )
    .addHelpText(
      "after",
      [
        "\nProvide either --transform (a module file) or --script (an inline expression or JS body).",
        "",
        "Filter functions receive 'item' and 'index' and must return true to keep the item or false to drop it.",
        "",
        "--transform module must export a default function or named 'filter':",
        '  export default (item, index) => item.type === "carecircle-invitation";',
        "",
        "--script accepts either a bare expression or the body of a function with 'item' and 'index' in scope:",
        "  Expressions are returned automatically. Function bodies must explicitly return true or false.",
        "",
        "Examples (inline --script):",
        "  ddbat filter --script 'item.type === \"carecircle-invitation\"'",
        "  ddbat filter --script 'return item.active && item.region === \"us-east-1\"'",
        "",
        "Examples (--transform module file):",
        "  ddbat filter --transform ./filters/keep-active.js --input data.json",
        "  cat data.json | ddbat filter -x ./filters/keep-active.js",
        "",
        "Chaining:",
        "  ddbat export --table users",
        "    | ddbat filter --script 'return item.active'",
        "    | ddbat transform --transform ./migrations/normalize.js",
        "    | ddbat import --table active-users",
        "",
      ].join("\n")
    )
    .option("-i, --input [file]", "Input file (omit to read from stdin)")

    .option("-x, --transform <file>", "Path to filter module file")
    .option(
      "-s, --script <js>",
      "Inline boolean expression or JS function body with 'item' and 'index' in scope"
    )
    .option("-o, --output [file]", "Output file path (defaults to stdout)")
    .option(
      "--format <format>",
      "Output format: jsonl (JSON lines, default) or json (JSON array)",
      "jsonl"
    )
    .option("--no-progress", "No animated progress indicator")
    .action(wrapCommandHandler(filterCommand));
}

async function filterCommand(options: Options = {}) {
  const { transform: transformFile, script } = options;
  const filterModeCount = [transformFile, script].filter(Boolean).length;

  if (filterModeCount === 0) {
    throw new Error("Provide either --transform <file> or --script <js>");
  }
  if (filterModeCount > 1) {
    throw new Error("--transform and --script are mutually exclusive. Provide only one.");
  }

  const filterFn = script ? createInlineFilter(script) : await loadFilterModule(transformFile!);
  await runItemProcessor(
    options,
    (item, index) => applyFilterToItem(item, index, filterFn),
    "Emitted"
  );
}

function createInlineFilter(script: string): FilterFn {
  try {
    return createDynamicFunction<FilterFn>(`return (${script});`, "--script");
  } catch (expressionError) {
    try {
      return createDynamicFunction<FilterFn>(script, "--script");
    } catch {
      throw expressionError;
    }
  }
}

async function loadFilterModule(transformFile: string): Promise<FilterFn> {
  return loadUserFunction<FilterFn>(transformFile, "filter", ["filter", "apply"]);
}

async function applyFilterToItem(
  item: DdbatItem,
  index: number,
  filterFn: FilterFn
): Promise<DdbatItem[]> {
  let res: boolean | Promise<boolean>;
  try {
    res = filterFn(item, index);
  } catch (err) {
    throw new Error(`Filter failed at item #${index + 1}: ${String(err)}`, { cause: err });
  }

  const keep = await res;
  if (typeof keep !== "boolean") {
    throw new Error(
      `Filter failed at item #${index + 1}: expected a boolean result, received ${describeValue(keep)}. Inline expressions can omit 'return', but multi-statement scripts must return true or false explicitly.`
    );
  }

  return keep ? [item] : [];
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
