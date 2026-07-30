#!/usr/bin/env node

import tab from "@bomb.sh/tab/commander";
import { Command } from "commander";
import { readdirSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, posix, resolve } from "path";
import { fileURLToPath } from "url";

import { handleErrorAndExit } from "./error.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageVersion = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
).version;

const APP_BANNER = "/\\/\\ ^..^ /\\/\\";

interface FileCompletionOptions {
  fileExtensions?: string[];
}

function currentCompletionToken(): string {
  const argv = process.argv;
  const doubleDashIndex = argv.indexOf("--");
  if (doubleDashIndex === -1 || doubleDashIndex === argv.length - 1) {
    return "";
  }

  return argv[argv.length - 1] ?? "";
}

function listPathCompletions(
  complete: (value: string, description: string) => void,
  options: FileCompletionOptions = {}
): void {
  const token = currentCompletionToken();
  const normalizedToken = token.replace(/\\/g, "/");
  const hasSlash = normalizedToken.includes("/");
  const tokenEndsWithSlash = normalizedToken.endsWith("/");

  const parentPath = tokenEndsWithSlash
    ? normalizedToken.slice(0, -1)
    : hasSlash
      ? normalizedToken.slice(0, normalizedToken.lastIndexOf("/"))
      : "";

  const searchPrefix = tokenEndsWithSlash
    ? ""
    : hasSlash
      ? normalizedToken.slice(normalizedToken.lastIndexOf("/") + 1)
      : normalizedToken;

  const fsParentPath = parentPath || ".";
  const searchDir = isAbsolute(fsParentPath)
    ? resolve(fsParentPath)
    : resolve(process.cwd(), fsParentPath);

  let entries;
  try {
    entries = readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryName = entry.name;

    if (!entryName.startsWith(searchPrefix)) {
      continue;
    }

    const isDir = entry.isDirectory();
    if (!isDir && options.fileExtensions?.length) {
      const hasAllowedExtension = options.fileExtensions.some((ext) =>
        entryName.toLowerCase().endsWith(ext.toLowerCase())
      );
      if (!hasAllowedExtension) {
        continue;
      }
    }

    const baseValue = parentPath ? posix.join(parentPath, entryName) : entryName;
    complete(isDir ? `${baseValue}/` : baseValue, isDir ? "directory" : "file");
  }
}

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

  const exportOutput = completion.commands.get("export")?.options.get("output");
  if (exportOutput) {
    exportOutput.handler = (complete) => {
      listPathCompletions(complete);
    };
  }

  const importInput = completion.commands.get("import")?.options.get("input");
  if (importInput) {
    importInput.handler = (complete) => {
      listPathCompletions(complete);
    };
  }

  const transformFile = completion.commands.get("transform")?.options.get("transform");
  if (transformFile) {
    transformFile.handler = (complete) => {
      listPathCompletions(complete, {
        fileExtensions: [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"],
      });
    };
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
