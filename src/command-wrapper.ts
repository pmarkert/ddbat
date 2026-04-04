/**
 * Wraps a command handler with standardized error handling
 */
import { handleErrorAndExit } from "./error.js";

export function wrapCommandHandler<T>(
  handler: (options: T) => Promise<void>
): (options: T) => Promise<void> {
  return async (options: T) => {
    try {
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
