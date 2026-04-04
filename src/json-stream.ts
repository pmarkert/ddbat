/**
 * Shared utilities for streaming JSON-lines (NDJSON) and JSON-array input/output.
 *
 * Input formats
 * ─────────────
 *  jsonl  – one JSON value per line (NDJSON).  Parsed with a simple chunk-
 *            splitting loop; zero extra dependencies.
 *  json   – a single JSON array  [ {…}, {…}, … ].  Streamed without loading
 *            the whole document into memory using @streamparser/json.
 *
 * Format auto-detection
 * ─────────────────────
 *  When `format` is omitted in streamItems() the function peeks at the first
 *  non-whitespace byte:  "[" → json array,  anything else → jsonl.
 */

import { once } from "events";
import { createWriteStream, mkdirSync } from "fs";
import { dirname } from "path";
import { Readable } from "stream";

import type { DdbatItem } from "./transform-types.js";

export type JsonFormat = "jsonl" | "json";

// ─── Input ────────────────────────────────────────────────────────────────────

/**
 * Yield DdbatItems from a Readable stream.
 * When `format` is omitted the format is auto-detected by peeking at the first
 * non-whitespace byte: "[" → JSON array, anything else → JSON lines.
 */
export async function* streamItems(
  readable: Readable,
  format?: JsonFormat
): AsyncGenerator<DdbatItem> {
  let stream = readable;
  let resolvedFormat = format;

  if (!resolvedFormat) {
    const peeked = await peekFormat(readable);
    resolvedFormat = peeked.format;
    stream = peeked.stream;
  }

  if (resolvedFormat === "jsonl") {
    yield* streamJsonLines(stream);
  } else {
    yield* streamJsonArray(stream);
  }
}

/**
 * Peek at the first non-whitespace byte to detect input format.
 * Returns the detected format and a new PassThrough Readable that still
 * contains all the original data (including the already-read bytes).
 */
async function peekFormat(readable: Readable): Promise<{ format: JsonFormat; stream: Readable }> {
  let detectedFormat: JsonFormat = "jsonl"; // default for empty streams
  const iterator = readable[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  const prefix: Buffer[] = [];
  let scannedText = "";

  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;

    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    prefix.push(chunk);
    scannedText += chunk.toString("utf8");

    const trimmed = scannedText.trimStart();
    if (trimmed.length > 0) {
      detectedFormat = trimmed[0] === "[" ? "json" : "jsonl";
      break;
    }
  }

  async function* replay(): AsyncGenerator<Buffer> {
    for (const chunk of prefix) {
      yield chunk;
    }

    while (true) {
      const { value, done } = await iterator.next();
      if (done) return;

      yield Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    }
  }

  return { format: detectedFormat, stream: Readable.from(replay()) };
}

async function writeChunk(
  writable: NodeJS.WritableStream,
  chunk: string | Uint8Array
): Promise<void> {
  if (writable.write(chunk)) {
    return;
  }

  await once(writable, "drain");
}

async function closeWritable(writable: ReturnType<typeof createWriteStream>): Promise<void> {
  if (writable.writableFinished) {
    return;
  }

  writable.end();
  await once(writable, "finish");
}

/** Stream items from JSONL — one JSON value per line. */
async function* streamJsonLines(readable: Readable): AsyncGenerator<DdbatItem> {
  let remainder = "";

  for await (const rawChunk of readable) {
    const chunk: string =
      typeof rawChunk === "string" ? rawChunk : (rawChunk as Buffer).toString("utf8");
    const lines = (remainder + chunk).split(/\r?\n/);
    remainder = lines.pop() ?? ""; // last element may be an incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield JSON.parse(trimmed) as DdbatItem;
    }
  }

  // Handle any final line that had no trailing newline
  const trimmed = remainder.trim();
  if (trimmed) yield JSON.parse(trimmed) as DdbatItem;
}

/** Stream items from a JSON array without loading the whole document. */
async function* streamJsonArray(readable: Readable): AsyncGenerator<DdbatItem> {
  const { JSONParser } = await import("@streamparser/json");

  // Async queue bridges the callback-based onValue API to for-await-of
  const queue: DdbatItem[] = [];
  let finished = false;
  let parseError: Error | null = null;
  let wakeup: (() => void) | null = null;

  const notify = () => {
    if (wakeup) {
      const w = wakeup;
      wakeup = null;
      w();
    }
  };
  const fail = (err: Error) => {
    parseError = err;
    finished = true;
    notify();
  };

  // paths: ['$.*'] emits every direct child of the root element.
  // For a JSON array this yields each array item, which is the expected usage.
  // If the root is unexpectedly a JSON object, each property value is emitted
  // instead — the parser will surface a clear error for malformed inputs.
  const parser = new JSONParser({ paths: ["$.*"], keepStack: false });
  parser.onValue = ({ value }) => {
    queue.push(value as DdbatItem);
    notify();
  };
  parser.onEnd = () => {
    finished = true;
    notify();
  };
  parser.onError = fail;

  // Feed the source stream to the parser in the background.
  // The promise is intentionally not awaited here; errors are propagated via
  // the `fail` callback which sets `parseError` and wakes the consumer loop.
  void (async () => {
    try {
      for await (const chunk of readable) {
        parser.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      parser.end();
    } catch (err) {
      fail(err as Error);
    }
  })();

  // Yield items as they are produced
  while (true) {
    const next = queue.shift();
    if (next !== undefined) {
      yield next;
    } else if (finished) {
      if (parseError) throw parseError;
      return;
    } else {
      await new Promise<void>((r) => {
        wakeup = r;
      });
    }
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

/** Write a single item as a JSONL line. */
export function writeJsonlItem(item: DdbatItem, writable: NodeJS.WritableStream): void {
  writable.write(JSON.stringify(item) + "\n");
}

/**
 * Open a streaming JSON-array output session.
 * Writes "[" immediately; call writeItem() for each item; call close() at end.
 */
export function openJsonArrayOutput(writable: NodeJS.WritableStream): {
  writeItem: (item: DdbatItem) => Promise<void>;
  close: () => Promise<void>;
} {
  let first = true;
  return {
    async writeItem(item: DdbatItem) {
      if (first) {
        await writeChunk(writable, "[\n");
      } else {
        await writeChunk(writable, ",\n");
      }

      await writeChunk(writable, JSON.stringify(item, null, 2));
      first = false;
    },
    async close() {
      if (first) {
        await writeChunk(writable, "[\n]\n");
        return;
      }

      await writeChunk(writable, "\n]\n");
    },
  };
}

/** Common interface returned by {@link openOutput}. */
export interface OutputSession {
  writeItem(item: DdbatItem): Promise<void>;
  close(): Promise<void>;
}

/**
 * Open an output session for the given format and destination.
 *
 * When `outputFile` is `"-"` or empty, output goes to stdout.
 * Otherwise a file stream is created (parent directories are created
 * automatically) and the stream is ended when `close()` is called.
 *
 * `close()` must always be called when writing is complete; for the JSON-array
 * format it also writes the closing `]`.
 */
export function openOutput(format: JsonFormat, outputFile: string): OutputSession {
  const isFile = !!outputFile && outputFile !== "-";
  const writable: NodeJS.WritableStream = isFile
    ? (() => {
        mkdirSync(dirname(outputFile), { recursive: true });
        return createWriteStream(outputFile);
      })()
    : process.stdout;

  const endFile = () => {
    if (isFile) {
      return closeWritable(writable as ReturnType<typeof createWriteStream>);
    }

    return Promise.resolve();
  };

  if (format === "json") {
    const arr = openJsonArrayOutput(writable);
    return {
      async writeItem(item) {
        await arr.writeItem(item);
      },
      async close() {
        await arr.close();
        await endFile();
      },
    };
  }

  return {
    async writeItem(item) {
      await writeChunk(writable, JSON.stringify(item) + "\n");
    },
    close: endFile,
  };
}
