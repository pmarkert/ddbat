/**
 * Type guard to check if a value is a standard Error object.
 */
function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Type guard to check if an object has a message property.
 */
function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as Record<string, unknown>).message === "string"
  );
}

/**
 * Safely extract error message from any value using type guards.
 */
export function getErrorMessage(err: unknown): string {
  if (isError(err)) {
    return err.message;
  }
  if (hasMessage(err)) {
    return err.message;
  }
  return String(err ?? "Unknown error");
}

/**
 * Safely extract error stack from any value using type guards.
 */
export function getErrorStack(err: unknown): string | undefined {
  if (isError(err)) {
    return err.stack;
  }
  return undefined;
}

export function formatError(err: unknown): {
  title: string;
  message: string;
  hint?: string;
} {
  const maybeMessage = getErrorMessage(err);
  const title = maybeMessage.split("\n")[0] || "Error";
  const msgLower = maybeMessage.toLowerCase();

  let hint: string | undefined;

  if (
    msgLower.includes("region is missing") ||
    msgLower.includes("missing region") ||
    msgLower.includes("no region")
  ) {
    hint =
      "AWS region is not configured. Set AWS_REGION, configure ~/.aws/config, or pass a region to your command.";
  } else if (
    msgLower.includes("credentials") ||
    msgLower.includes("access key") ||
    msgLower.includes("no credentials") ||
    msgLower.includes("could not load credentials")
  ) {
    hint =
      "AWS credentials not found. Configure AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, set a profile, or run 'aws configure'.";
  }

  return { title, message: maybeMessage, hint };
}

export function handleErrorAndExit(err: unknown): never {
  const out = formatError(err);

  // Primary short message
  console.error(`Error: ${out.title}`);

  // Provide the concise message underneath (avoid printing large stacks by default)
  if (out.message && out.message !== out.title) {
    console.error(out.message);
  }

  if (out.hint) {
    console.error(`Hint: ${out.hint}`);
  }

  // If developer needs debugging details, allow showing full stack by enabling DEBUG
  const debug = Boolean(process.env.DEBUG);
  if (debug) {
    const stack = getErrorStack(err);
    if (stack) {
      console.error(stack);
    } else {
      console.error(String(err));
    }
  }

  // Use non-zero exit code to indicate failure
  process.exit(1);
}
