import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Command } from "commander";
import { createReadStream } from "fs";
import { Readable } from "stream";

import { wrapCommandHandler } from "../command-wrapper.js";
import { streamItems } from "../json-stream.js";
import { createProgressRenderer } from "../progress.js";
import { DdbatItem } from "../transform-types.js";
import { dynamoClient } from "../util.js";

interface Options {
  table?: string;
  input?: string;
  progress?: boolean;
}

export function setup(program: Command) {
  program
    .command("import")
    .description("Import a JSON file to a DynamoDB table")
    .option("-t, --table <tableName>", "Destination table name [required]")
    .option("-i, --input [file]", "Input file (defaults to stdin)")

    .option("--no-progress", "No animated progress indicator")
    .action(wrapCommandHandler(importCommand));
}

async function importCommand(options: Options = {}) {
  const toTable = options.table || process.env.DDBAT_TABLE;

  if (!toTable) {
    throw new Error("Destination table name is required. Provide --table or set DDBAT_TABLE");
  }

  const inputSource = options.input ?? (process.stdin.isTTY ? undefined : "-");
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

    await dynamoClient.send(
      new BatchWriteCommand({
        RequestItems: { [toTable]: batch.map((Item) => ({ PutRequest: { Item } })) },
      })
    );

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

  progress.end(`Imported ${totalWritten} items from ${inputLabel} into ${toTable}`);
}
