/**
 * Wraps a command handler with standardized error handling
 */
import { handleErrorAndExit } from "./error.js";

function isTruthyEnvToggle(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export function wrapCommandHandler<T>(
  handler: (options: T) => Promise<void>
): (options: T) => Promise<void> {
  return async (options: T) => {
    try {
      if (
        isTruthyEnvToggle(process.env.DDBAT_DRYRUN) &&
        typeof options === "object" &&
        options !== null &&
        "dryRun" in options
      ) {
        (options as { dryRun?: boolean }).dryRun = true;
      }

      await handler(options);
    } catch (error) {
      if (error instanceof Error && error.name === "ExitPromptError") {
        console.error("\nOperation cancelled.");
        process.exit(0);
      }

      // Use centralized handler to format and exit
      handleErrorAndExit(error);
    }
  };
}
