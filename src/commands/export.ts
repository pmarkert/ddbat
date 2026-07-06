import { Command } from "commander";

import { wrapCommandHandler } from "../command-wrapper.js";
import { addFilterOptions, FilterCommandOptions, parseFilterOptions } from "../filter-options.js";
import { JsonFormat, openOutput } from "../json-stream.js";
import { createProgressRenderer } from "../progress.js";
import { createInterruptTracker, parseStartKey, printResumeHint } from "../resume.js";
import { DdbatItem } from "../transform-types.js";
import { getTableKeySchema, queryTablePage } from "../util.js";

interface Options extends FilterCommandOptions {
  table?: string;
  output?: string;
  format?: JsonFormat;
  progress?: boolean;
  startKey?: DdbatItem;
  limit?: number;
  reverse?: boolean;
}

const EXPORT_PAGE_SIZE = 1000;

export function setup(program: Command) {
  const command = program
    .command("export")
    .description("Export a DynamoDB table to a JSON file")
    .option("-t, --table <tableName>", "Source table name [required] (default: $DDBAT_TABLE)")
    .option("-o, --output [file]", "Output file path (defaults to stdout)")
    .option(
      "--start-key <json>",
      "Resume from a DynamoDB LastEvaluatedKey JSON object",
      parseStartKey
    )
    .option(
      "--format <format>",
      "Output format: jsonl (JSON lines, default) or json (JSON array)",
      "jsonl"
    )
    .option("--reverse", "Read query results in descending sort-key order")
    .option("--limit <count>", "Maximum number of items to export", (value: string) => {
      const n = parseInt(value, 10);
      if (isNaN(n) || n <= 0) throw new Error("--limit must be a positive integer");
      return n;
    });

  // Add filter options
  addFilterOptions(command);

  command.option("--no-progress", "No animated progress indicator");

  command.action(wrapCommandHandler(exportCommand));
}

async function exportCommand(options: Options = {}) {
  const fromTable = options.table || process.env.DDBAT_TABLE;
  const outputFile = options.output ?? "-";
  const format: JsonFormat = options.format === "json" ? "json" : "jsonl";

  if (!fromTable) {
    throw new Error("Source table name is required. Provide --table or set DDBAT_TABLE");
  }

  // Get table key schema
  const keySchema = await getTableKeySchema(fromTable);

  // Parse query options using shared function
  const queryOptions = parseFilterOptions(options, keySchema);
  if (options.reverse) {
    if (queryOptions.partitionKey) {
      queryOptions.scanIndexForward = false;
    } else {
      console.error("Ignoring --reverse because full table/index scans do not support reverse traversal");
    }
  }

  // Log query type
  if (queryOptions.partitionKey) {
    console.error(
      `Querying with partition key: ${queryOptions.partitionKey.name}=${queryOptions.partitionKey.value}`
    );
    if (options.reverse) {
      console.error("Sort-key order: descending (--reverse)");
    }
    if (queryOptions.indexName) {
      console.error(`Using index: ${queryOptions.indexName}`);
    }
  } else {
    console.error("Performing full table scan");
  }
  if (options.startKey) {
    console.error(`Starting from cursor: ${JSON.stringify(options.startKey)}`);
  }

  let totalItems = 0;
  const writer = openOutput(format, outputFile);
  const progress = createProgressRenderer(options.progress ?? !process.stdout.isTTY);
  const interruptTracker = createInterruptTracker();
  let writerClosed = false;
  let nextStartKey = options.startKey;
  let resumeStartKey = nextStartKey;

  const closeWriter = async () => {
    if (writerClosed) {
      return;
    }

    writerClosed = true;
    await writer.close();
  };

  try {
    let nextKey: DdbatItem | undefined;
    do {
      const requestStartKey = nextStartKey;
      const page = await queryTablePage(fromTable, queryOptions, EXPORT_PAGE_SIZE, nextStartKey);

      for (const item of page.items) {
        await writer.writeItem(item);
        totalItems++;
        if (totalItems % 1000 === 0) {
          progress.update(totalItems);
        }
        if (options.limit && totalItems >= options.limit) {
          break;
        }
      }

      nextKey = page.lastEvaluatedKey;
      resumeStartKey = nextKey ?? requestStartKey;
      if (interruptTracker.stopRequested()) {
        await closeWriter();
        const summary =
          outputFile && outputFile !== "-"
            ? `Export interrupted after ${totalItems} items from ${fromTable} to ${outputFile}`
            : `Export interrupted after ${totalItems} items from ${fromTable}`;
        progress.end(summary);
        printResumeHint("export", resumeStartKey);
        return;
      }

      if (options.limit && totalItems >= options.limit) {
        break;
      }

      nextStartKey = nextKey;
    } while (nextKey);
  } catch (error) {
    printResumeHint("export", resumeStartKey);
    throw error;
  } finally {
    await closeWriter();
    interruptTracker.dispose();
  }

  const summary =
    outputFile && outputFile !== "-"
      ? `Exported ${totalItems} items from ${fromTable} to ${outputFile}`
      : `Exported ${totalItems} items from ${fromTable}`;
  progress.end(summary);
}
