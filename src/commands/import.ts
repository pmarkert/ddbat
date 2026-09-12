import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Command } from "commander";
import { createReadStream } from "fs";
import { Readable } from "stream";

import { wrapCommandHandler } from "../command-wrapper.js";
import { resolvePathOption, streamItems } from "../json-stream.js";
import { createProgressRenderer } from "../progress.js";
import { DdbatItem } from "../transform-types.js";
import { dynamoClient } from "../util.js";

interface Options {
  table?: string;
  // `--input [file]` has an optional value, so commander may hand back `true`.
  input?: string | boolean;
  dryRun?: boolean;
  progress?: boolean;
}

export function setup(program: Command) {
  program
    .command("import")
    .description("Import a JSON file to a DynamoDB table")
    .option("-t, --table <tableName>", "Destination table name [required] (default: $DDBAT_TABLE)")
    .option("-i, --input [file]", "Input file (defaults to stdin)")
    .option(
      "--dry-run",
      "Parse and count input items without writing to DynamoDB (or set DDBAT_DRYRUN=1)"
    )

    .option("--no-progress", "No animated progress indicator")
    .action(wrapCommandHandler(importCommand));
}

async function importCommand(options: Options = {}) {
  const toTable = options.table || process.env.DDBAT_TABLE;

  if (!toTable) {
    throw new Error("Destination table name is required. Provide --table or set DDBAT_TABLE");
  }

  const inputSource = resolvePathOption(options.input) ?? (process.stdin.isTTY ? undefined : "-");
  if (!inputSource) {
    throw new Error("No input provided. Pipe data to stdin or use --input <file>.");
  }
  let inputStream: Readable;
  if (inputSource === "-") {
    inputStream = process.stdin as Readable;
  } else {
    inputStream = createReadStream(inputSource);
  }

  const inputLabel = inputSource !== "-" ? inputSource : "stdin";

  // Batch write to DynamoDB (max 25 items per batch)
  const BATCH_SIZE = 25;
  let batch: DdbatItem[] = [];
  let totalWritten = 0;
  const progress = createProgressRenderer(options.progress);

  const flushBatch = async () => {
    if (batch.length === 0) return;

    if (!options.dryRun) {
      await dynamoClient.send(
        new BatchWriteCommand({
          RequestItems: { [toTable]: batch.map((Item) => ({ PutRequest: { Item } })) },
        })
      );
    }

    totalWritten += batch.length;
    if (totalWritten % 100 === 0) {
      progress.update(totalWritten);
    }
    batch = [];
  };

  for await (const item of streamItems(inputStream)) {
    batch.push(item);
    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
    }
  }

  await flushBatch();

  if (options.dryRun) {
    progress.end(`[DRY RUN] Would import ${totalWritten} items from ${inputLabel} into ${toTable}`);
  } else {
    progress.end(`Imported ${totalWritten} items from ${inputLabel} into ${toTable}`);
  }
}
