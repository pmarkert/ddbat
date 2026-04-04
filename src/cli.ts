#!/usr/bin/env node

import { NewCommand } from "@gutenye/commander-completion-carapace";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { handleErrorAndExit } from "./error.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageVersion = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
).version;

const APP_BANNER = "/\\/\\ ^..^ /\\/\\";

async function main() {
  const program = new NewCommand();

  program
    .name("ddbat")
    .description(APP_BANNER + "\n\nCLI tool to import/export/delete/transform DynamoDB records")
    .version(packageVersion)
    .showHelpAfterError("(add --help for additional information)")
    .enableCompletion();

  // Auto-discover and register all commands from the commands folder
  const commandsDir = join(__dirname, "commands");
  const commandFiles = readdirSync(commandsDir).filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const commandModule = await import(join(commandsDir, file));
    if (commandModule.setup && typeof commandModule.setup === "function") {
      commandModule.setup(program);
    }
  }

  // Add completion command
  program
    .command("completion")
    .description("Install shell completion for ddbat")
    .action(async () => {
      await program.installCompletion();
      console.log("\nShell completion has been installed!");
      console.log("Restart your shell or run: source ~/.zshrc (or ~/.bashrc)");
    });

  program.parse();
}

// Global unhandled rejection and exception handlers
process.on("unhandledRejection", (reason) => {
  handleErrorAndExit(reason);
});

process.on("uncaughtException", (err) => {
  handleErrorAndExit(err);
});

// Run main and catch synchronous async errors
main().catch((err) => handleErrorAndExit(err));
