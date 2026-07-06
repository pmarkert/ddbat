#!/usr/bin/env node

import tab from "@bomb.sh/tab/commander";
import { Command } from "commander";
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

function addOptionValueCompletions(completion: ReturnType<typeof tab>): void {
  const formatValues = ["json", "jsonl", "full", "keys", "count", "silent"];

  for (const commandName of ["export", "delete", "transform", "filter"]) {
    const formatOption = completion.commands.get(commandName)?.options.get("format");
    if (formatOption) {
      formatOption.handler = (complete) => {
        for (const value of formatValues) {
          complete(value, "");
        }
      };
    }
  }

  for (const commandName of ["export", "delete"]) {
    const skOption = completion.commands.get(commandName)?.options.get("sk");
    if (skOption) {
      skOption.handler = (complete) => {
        complete(">=", "greater than or equal");
        complete("<=", "less than or equal");
        complete(">", "greater than");
        complete("<", "less than");
        complete("=", "equal");
        complete("begins_with(", "starts-with expression");
        complete("between(", "range expression");
      };
    }
  }
}

async function main() {
  const program = new Command();

  program
    .name("ddbat")
    .description(APP_BANNER + "\n\nCLI tool to import/export/delete/transform DynamoDB records")
    .version(packageVersion)
    .showHelpAfterError("(add --help for additional information)");

  // Auto-discover and register all commands from the commands folder
  const commandsDir = join(__dirname, "commands");
  const commandFiles = readdirSync(commandsDir).filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const commandModule = await import(join(commandsDir, file));
    if (commandModule.setup && typeof commandModule.setup === "function") {
      commandModule.setup(program);
    }
  }

  const completion = tab(program, { completionCommandName: "completion" });
  addOptionValueCompletions(completion);

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
