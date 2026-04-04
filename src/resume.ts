import { getErrorMessage } from "./error.js";
import { DdbatItem } from "./transform-types.js";

const RESUME_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export function parseStartKey(value: string): DdbatItem {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Start key must be a JSON object.");
    }

    return parsed as DdbatItem;
  } catch (error) {
    throw new Error(`Invalid --start-key value: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
}

export function formatStartKey(startKey?: DdbatItem): string | undefined {
  if (!startKey) {
    return undefined;
  }

  return JSON.stringify(startKey);
}

export function printResumeHint(commandName: string, startKey?: DdbatItem) {
  const formattedKey = formatStartKey(startKey);
  if (!formattedKey) {
    return;
  }

  console.error(`Resume cursor: ${formattedKey}`);
  console.error(`Resume with: ddbat ${commandName} --start-key ${JSON.stringify(formattedKey)}`);
}

export interface InterruptTracker {
  stopRequested(): boolean;
  stopSignal(): NodeJS.Signals | undefined;
  dispose(): void;
}

export function createInterruptTracker(): InterruptTracker {
  let receivedSignal: NodeJS.Signals | undefined;
  let announced = false;

  const handlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of RESUME_SIGNALS) {
    const handler = () => {
      receivedSignal = receivedSignal ?? signal;
      if (!announced) {
        announced = true;
        console.error(`\nReceived ${signal}. Stopping after the current prompt or page...`);
      }
    };

    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return {
    stopRequested() {
      return receivedSignal !== undefined;
    },
    stopSignal() {
      return receivedSignal;
    },
    dispose() {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    },
  };
}
