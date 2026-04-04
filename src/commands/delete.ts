import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Command } from "commander";
import * as readline from "readline";

import { wrapCommandHandler } from "../command-wrapper.js";
import { addFilterOptions, FilterCommandOptions, parseFilterOptions } from "../filter-options.js";
import { openOutput, OutputSession } from "../json-stream.js";
import { createProgressRenderer } from "../progress.js";
import { createInterruptTracker, parseStartKey, printResumeHint } from "../resume.js";
import { DdbatItem } from "../transform-types.js";
import {
  countTable,
  dynamoClient,
  extractKeys,
  getTableKeySchema,
  QueryPage,
  queryTablePage,
} from "../util.js";

interface Options extends FilterCommandOptions {
  table?: string;
  dryRun?: boolean;
  force?: boolean;
  count?: boolean;
  format?: "full" | "keys" | "count" | "silent";
  pageSize?: number;
  progress?: boolean;
  startKey?: DdbatItem;
}

type DeleteFormat = Options["format"];
type TableKeySchema = Awaited<ReturnType<typeof getTableKeySchema>>;
type DeleteAction = "delete-all" | "delete-page" | "next-page" | "quit";

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_TTY_PADDING = 10;
const DELETE_BATCH_SIZE = 25;

function parsePositiveInteger(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--page-size must be a positive integer.");
  }

  return parsed;
}

function resolvePageSize(pageSize?: number) {
  if (pageSize) {
    return pageSize;
  }

  if (process.stderr.isTTY && typeof process.stderr.rows === "number") {
    return Math.max(5, process.stderr.rows - PAGE_SIZE_TTY_PADDING);
  }

  return DEFAULT_PAGE_SIZE;
}

function hasVerboseOutput(format?: DeleteFormat) {
  return !format || format !== "silent";
}

function usesPagedPrompt(format?: DeleteFormat) {
  return format !== "count" && format !== "silent";
}

function createDeleteOutput(format?: DeleteFormat) {
  if (format === "full" || format === "keys") {
    return openOutput("json", "-");
  }

  return undefined;
}

function renderDeletePreviewPage(
  items: DdbatItem[],
  keySchema: TableKeySchema,
  pageNumber: number,
  pageSize: number,
  startIndex: number,
  totalCount?: number,
  deletedCount: number = 0,
  hasMore: boolean = false
) {
  const startNumber = startIndex + 1;
  const endNumber = startIndex + items.length;

  console.error("");
  if (typeof totalCount === "number") {
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    console.error(
      `Page ${pageNumber} of ${totalPages}. Showing items ${startNumber}-${endNumber} of ${totalCount}.`
    );
  } else {
    console.error(
      `Page ${pageNumber}. Showing items ${startNumber}-${endNumber}. Total count skipped (--no-count).`
    );
  }

  if (deletedCount > 0) {
    console.error(`Deleted so far: ${deletedCount}`);
  }

  console.error("Preview of keys on this page:");
  console.error("-".repeat(60));
  items.forEach((item, index) => {
    console.error(`${startIndex + index + 1}. ${JSON.stringify(extractKeys(item, keySchema))}`);
  });
  console.error("-".repeat(60));

  const remainingCount = typeof totalCount === "number" ? totalCount - startIndex : undefined;
  console.error("Actions:");
  if (typeof remainingCount === "number") {
    console.error(`  all  Delete all remaining items from this page onward (${remainingCount})`);
  } else {
    console.error("  all  Delete all remaining items from this page onward");
  }
  console.error(
    `  d    Delete this page (${items.length})${hasMore ? ", then show the next page" : ""}`
  );
  if (hasMore) {
    console.error("  n    Show the next page without deleting this one");
  }
  console.error("  q    Stop now without deleting this page or any later pages");
}

function promptQuestion(rl: readline.Interface, prompt: string) {
  return new Promise<string>((resolve) => {
    const onSigint = () => {
      rl.off("SIGINT", onSigint);
      rl.close();
      resolve("\u001b");
    };

    rl.once("SIGINT", onSigint);
    rl.question(prompt, (answer) => {
      rl.off("SIGINT", onSigint);
      resolve(answer);
    });
  });
}

async function promptDeleteAction(rl: readline.Interface, hasMore: boolean) {
  while (true) {
    const defaultAction = hasMore ? "n" : "q";
    const answer = await promptQuestion(rl, `Action [${defaultAction}]: `);
    const normalized = (answer.trim() || defaultAction).toLowerCase();

    if (normalized === "all") {
      return "delete-all" satisfies DeleteAction;
    }

    if (normalized === "d" || normalized === "delete") {
      return "delete-page" satisfies DeleteAction;
    }

    if (hasMore && (normalized === "n" || normalized === "next")) {
      return "next-page" satisfies DeleteAction;
    }

    if (normalized === "q" || normalized === "quit" || normalized === "\u001b") {
      return "quit" satisfies DeleteAction;
    }

    console.error('Enter "all", "d", "n", or "q", then Enter.');
  }
}

async function promptDeleteAllConfirmation(rl: readline.Interface, totalCount?: number) {
  while (true) {
    const target =
      typeof totalCount === "number"
        ? `${totalCount} matching items`
        : "all remaining matching items";
    const answer = await promptQuestion(rl, `Type "all" to delete ${target}, or "q" to cancel: `);
    const normalized = answer.trim().toLowerCase();

    if (normalized === "all") {
      return true;
    }

    if (
      normalized === "q" ||
      normalized === "quit" ||
      normalized === "\u001b" ||
      normalized === ""
    ) {
      return false;
    }

    console.error('Enter "all" to continue or "q" to cancel.');
  }
}

async function writeDeletedItems(
  output: OutputSession | undefined,
  format: DeleteFormat,
  items: DdbatItem[],
  keySchema: TableKeySchema
) {
  if (!output) {
    return;
  }

  for (const item of items) {
    await output.writeItem(format === "keys" ? extractKeys(item, keySchema) : item);
  }
}

async function deleteItemsPage(
  tableName: string,
  items: DdbatItem[],
  keySchema: TableKeySchema,
  progress: ReturnType<typeof createProgressRenderer>,
  currentDeletedCount: number,
  totalCount: number | undefined,
  output: OutputSession | undefined,
  format: DeleteFormat
) {
  let deletedCount = 0;

  for (let index = 0; index < items.length; index += DELETE_BATCH_SIZE) {
    const batch = items.slice(index, index + DELETE_BATCH_SIZE);
    const deleteRequests = batch.map((item) => ({
      DeleteRequest: {
        Key: extractKeys(item, keySchema),
      },
    }));

    await dynamoClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: deleteRequests,
        },
      })
    );

    await writeDeletedItems(output, format, batch, keySchema);

    deletedCount += batch.length;
    progress.update(
      currentDeletedCount + deletedCount,
      typeof totalCount === "number" ? `/ ${totalCount}` : ""
    );
  }

  return deletedCount;
}

async function streamDryRunOutput(
  tableName: string,
  queryOptions: ReturnType<typeof parseFilterOptions>,
  keySchema: TableKeySchema,
  firstPage: QueryPage,
  pageSize: number,
  format: DeleteFormat
) {
  const output = createDeleteOutput(format);

  if (!output) {
    return;
  }

  try {
    let page: QueryPage = firstPage;
    while (page.items.length > 0) {
      await writeDeletedItems(output, format, page.items, keySchema);
      if (!page.lastEvaluatedKey) {
        break;
      }

      page = await queryTablePage(tableName, queryOptions, pageSize, page.lastEvaluatedKey);
    }
  } finally {
    await output.close();
  }
}

async function loadNextPage(
  tableName: string,
  queryOptions: ReturnType<typeof parseFilterOptions>,
  pageSize: number,
  page: QueryPage
) {
  if (!page.lastEvaluatedKey) {
    return undefined;
  }

  return {
    startKey: page.lastEvaluatedKey,
    page: await queryTablePage(tableName, queryOptions, pageSize, page.lastEvaluatedKey),
  };
}

export function setup(program: Command) {
  const command = program
    .command("delete")
    .description("Delete matching items from a DynamoDB table (requires query filters)")
    .option("-t, --table <tableName>", "Table name [required]")
    .option("--dry-run", "Preview items to be deleted without actually deleting")
    .option("--force", "Skip confirmation prompt and delete immediately")
    .option("--no-count", "Skip the initial count query before paging through matches")
    .option(
      "--start-key <json>",
      "Resume from a DynamoDB LastEvaluatedKey JSON object",
      parseStartKey
    )
    .option(
      "--page-size <number>",
      "Number of matching items to show per page during interactive delete",
      parsePositiveInteger
    )
    .option(
      "--format <type>",
      "Output format: full (full items), keys (just keys), count (item count), silent (no output)"
    );

  // Add filter options
  addFilterOptions(command);

  command.option("--no-progress", "No animated progress indicator");

  command.action(wrapCommandHandler(deleteCommand));
}

async function deleteCommand(options: Options = {}) {
  const tableName = options.table || process.env.DDBAT_TABLE;
  const pageSize = resolvePageSize(options.pageSize);
  const interruptTracker = createInterruptTracker();

  if (!tableName) {
    throw new Error("Table name is required. Provide --table or set DDBAT_TABLE");
  }

  // Get table key schema
  const keySchema = await getTableKeySchema(tableName);

  // Parse query options using shared function
  const queryOptions = parseFilterOptions(options, keySchema);

  // Log query type
  console.error("=".repeat(60));
  if (queryOptions.partitionKey) {
    console.error(
      `Query type: Partition key filter (${queryOptions.partitionKey.name}=${queryOptions.partitionKey.value})`
    );
    if (queryOptions.indexName) {
      console.error(`Using index: ${queryOptions.indexName}`);
    }
    if (queryOptions.sortKey) {
      console.error(
        `Sort key filter: ${queryOptions.sortKey.name} ${queryOptions.sortKey.operator} ${queryOptions.sortKey.value}`
      );
    }
  } else {
    console.error("Query type: Full table scan");
  }
  if (queryOptions.filterExpression) {
    console.error(`Filter expression: ${queryOptions.filterExpression}`);
  }
  if (options.startKey) {
    console.error(`Starting from cursor: ${JSON.stringify(options.startKey)}`);
  }
  console.error(`Page size: ${pageSize}`);
  console.error("=".repeat(60));

  let totalCount: number | undefined;
  if (options.count !== false) {
    console.error("\nCounting matching items...");
    totalCount = await countTable(tableName, queryOptions, options.startKey);
    console.error(`Found ${totalCount} matching items.`);

    if (totalCount === 0) {
      if (options.format === "count") {
        process.stdout.write("0");
      } else {
        console.error("No items to delete.");
      }
      return;
    }
  } else {
    console.error("\nSkipping initial count (--no-count).");
  }

  console.error("\nLoading first page of matching items...");
  let currentPageStartKey = options.startKey;
  let currentPage = await queryTablePage(tableName, queryOptions, pageSize, currentPageStartKey);

  if (currentPage.items.length === 0) {
    if (options.format === "count") {
      process.stdout.write("0");
    }
    console.error("No items to delete.");
    return;
  }

  if (hasVerboseOutput(options.format)) {
    const mode = options.dryRun ? "[DRY RUN] " : "";
    const countLabel = typeof totalCount === "number" ? `${totalCount}` : "an unknown number of";
    console.error(
      `${mode}${options.dryRun ? "Would delete" : "Will delete"} ${countLabel} items matching this query.`
    );
    if (usesPagedPrompt(options.format) && (options.force || options.dryRun)) {
      renderDeletePreviewPage(
        currentPage.items,
        keySchema,
        1,
        pageSize,
        0,
        totalCount,
        0,
        Boolean(currentPage.lastEvaluatedKey)
      );
    }
  }

  if (options.dryRun) {
    if (hasVerboseOutput(options.format)) {
      console.error("\n[DRY RUN] Delete was not executed. Remove --dry-run to actually delete.");
    }

    if (options.format === "count") {
      const dryRunCount = totalCount ?? (await countTable(tableName, queryOptions));
      process.stdout.write(String(dryRunCount));
    } else if (options.format === "full" || options.format === "keys") {
      await streamDryRunOutput(
        tableName,
        queryOptions,
        keySchema,
        currentPage,
        pageSize,
        options.format
      );
    }

    return;
  }

  let totalDeleted = 0;
  const progress = createProgressRenderer(options.progress && options.format !== "silent");
  const output = createDeleteOutput(options.format);
  let stoppedEarly = false;
  let deletionAnnounced = false;
  let resumeStartKey = currentPageStartKey;

  try {
    if (options.force) {
      while (currentPage.items.length > 0) {
        const nextPage = await loadNextPage(tableName, queryOptions, pageSize, currentPage);
        if (!deletionAnnounced && hasVerboseOutput(options.format)) {
          console.error("\nDeleting items...");
          deletionAnnounced = true;
        }

        totalDeleted += await deleteItemsPage(
          tableName,
          currentPage.items,
          keySchema,
          progress,
          totalDeleted,
          totalCount,
          output,
          options.format
        );

        resumeStartKey = currentPage.lastEvaluatedKey;
        if (interruptTracker.stopRequested()) {
          stoppedEarly = true;
          break;
        }

        if (!nextPage) {
          break;
        }

        currentPageStartKey = nextPage.startKey;
        currentPage = nextPage.page;
      }
    } else if (usesPagedPrompt(options.format)) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      try {
        let pageNumber = 1;
        let startIndex = 0;

        while (currentPage.items.length > 0) {
          if (interruptTracker.stopRequested()) {
            stoppedEarly = true;
            resumeStartKey = currentPageStartKey;
            break;
          }

          renderDeletePreviewPage(
            currentPage.items,
            keySchema,
            pageNumber,
            pageSize,
            startIndex,
            totalCount,
            totalDeleted,
            Boolean(currentPage.lastEvaluatedKey)
          );

          const action = await promptDeleteAction(rl, Boolean(currentPage.lastEvaluatedKey));
          if (action === "quit") {
            stoppedEarly = true;
            resumeStartKey = currentPageStartKey;
            break;
          }

          if (action === "next-page") {
            if (!currentPage.lastEvaluatedKey) {
              break;
            }

            startIndex += currentPage.items.length;
            pageNumber += 1;
            currentPageStartKey = currentPage.lastEvaluatedKey;
            currentPage = await queryTablePage(tableName, queryOptions, pageSize, currentPageStartKey);
            continue;
          }

          const nextPage = await loadNextPage(tableName, queryOptions, pageSize, currentPage);
          if (!deletionAnnounced && hasVerboseOutput(options.format)) {
            console.error("\nDeleting items...");
            deletionAnnounced = true;
          }

          totalDeleted += await deleteItemsPage(
            tableName,
            currentPage.items,
            keySchema,
            progress,
            totalDeleted,
            totalCount,
            output,
            options.format
          );

          resumeStartKey = currentPage.lastEvaluatedKey;
          if (interruptTracker.stopRequested()) {
            stoppedEarly = true;
            break;
          }

          if (action === "delete-all") {
            if (!nextPage) {
              currentPage = { items: [] };
              break;
            }

            currentPageStartKey = nextPage.startKey;
            currentPage = nextPage.page;
            while (currentPage.items.length > 0) {
              const followingPage = await loadNextPage(
                tableName,
                queryOptions,
                pageSize,
                currentPage
              );

              totalDeleted += await deleteItemsPage(
                tableName,
                currentPage.items,
                keySchema,
                progress,
                totalDeleted,
                totalCount,
                output,
                options.format
              );

              resumeStartKey = currentPage.lastEvaluatedKey;
              if (interruptTracker.stopRequested()) {
                stoppedEarly = true;
                break;
              }

              if (!followingPage) {
                currentPage = { items: [] };
                break;
              }

              currentPageStartKey = followingPage.startKey;
              currentPage = followingPage.page;
            }
            break;
          }

          if (!nextPage) {
            break;
          }

          startIndex += currentPage.items.length;
          pageNumber += 1;
          currentPageStartKey = nextPage.startKey;
          currentPage = nextPage.page;
        }

        if (stoppedEarly) {
          if (totalDeleted === 0) {
            console.error("Deletion cancelled. No items were deleted.");
          } else {
            progress.end(`Stopped after deleting ${totalDeleted} items from ${tableName}`);
          }
        }
      } finally {
        rl.close();
      }
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      try {
        const confirmed = await promptDeleteAllConfirmation(rl, totalCount);
        if (!confirmed) {
          console.error("Deletion cancelled. No items were deleted.");
          return;
        }
      } finally {
        rl.close();
      }

      while (currentPage.items.length > 0) {
        const nextPage = await loadNextPage(tableName, queryOptions, pageSize, currentPage);
        if (!deletionAnnounced && hasVerboseOutput(options.format)) {
          console.error("\nDeleting items...");
          deletionAnnounced = true;
        }

        totalDeleted += await deleteItemsPage(
          tableName,
          currentPage.items,
          keySchema,
          progress,
          totalDeleted,
          totalCount,
          output,
          options.format
        );

        resumeStartKey = currentPage.lastEvaluatedKey;
        if (interruptTracker.stopRequested()) {
          stoppedEarly = true;
          break;
        }

        if (!nextPage) {
          break;
        }

        currentPageStartKey = nextPage.startKey;
        currentPage = nextPage.page;
      }
    }

    if (options.format === "count") {
      process.stdout.write(String(totalDeleted));
    }

    if (stoppedEarly) {
      printResumeHint("delete", resumeStartKey);
    }

    if (hasVerboseOutput(options.format) && totalDeleted > 0 && !stoppedEarly) {
      progress.end(`✓ Successfully deleted ${totalDeleted} items from ${tableName}`);
    }
  } catch (error) {
    printResumeHint("delete", resumeStartKey);
    throw error;
  } finally {
    interruptTracker.dispose();
    if (output) {
      await output.close();
    }
  }
}
