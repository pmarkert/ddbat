/**
 * Progress renderer with animated bat spinner.
 * Displays animation only when stderr is a TTY; safe for piping.
 */

import readline from "readline";

const BAT_FRAMES = [
  "/\\/\\ ^..^ /\\/\\   |",
  "\\/\\/ ^..^ \\/\\/   |",
  "/\\/\\ ^..^ /\\/\\   |",
  "\\/\\/ ^..^ \\/\\/   |",
  " /\\/\\ ^..^ /\\/\\  |",
  " \\/\\/ ^..^ \\/\\/  |",
  " /\\/\\ ^..^ /\\/\\  |",
  " \\/\\/ ^..^ \\/\\/  |",
  "   /\\/\\ ^..^ /\\/\\|",
  "   \\/\\/ ^..^ \\/\\/|",
  "   /\\/\\ ^..^ /\\/\\|",
  "   \\/\\/ ^..^ \\/\\/|",
  " /\\/\\ ^  ^ /\\/\\  |",
  " \\/\\/ ^  ^ \\/\\/  |",
  " /\\/\\ ^..^ /\\/\\  |",
  " \\/\\/ ^..^ \\/\\/  |",
];

export interface ProgressRenderer {
  update(itemCount: number, extra?: string): void;
  end(summary: string): void;
}

/**
 * Create a progress renderer. Returns an object with update() and end() methods.
 * Animation is only shown when stderr is a TTY. Safe for piping.
 *
 * @param enabled - Whether progress animation should be active. Pass false to disable.
 * @returns Object with update(itemCount, extra) and end(summary) methods.
 */
export function createProgressRenderer(enabled: boolean = true): ProgressRenderer {
  const isInteractive = enabled && process.stderr.isTTY;
  let frameIndex = 0;

  return {
    update(itemCount: number, extra: string = "") {
      if (!isInteractive || BAT_FRAMES.length === 0) return;

      const frame = BAT_FRAMES[frameIndex];
      frameIndex = (frameIndex + 1) % BAT_FRAMES.length;

      const text = `${frame} ${itemCount}${extra ? " " + extra : ""} `;
      readline.clearLine(process.stderr, 0);
      readline.cursorTo(process.stderr, 0);
      process.stderr.write(text);
    },

    end(summary: string) {
      if (isInteractive) {
        readline.clearLine(process.stderr, 0);
        readline.cursorTo(process.stderr, 0);
        process.stderr.write(summary + "\n");
      }
    },
  };
}
