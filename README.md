# DDBat

![DDBat logo](doc/ddbat_logo_640.png)

A CLI tool for streaming DynamoDB operations. Export, import, transform, and delete items via stdio.

Pronounced: either "diddy-bat" or "dee-dee-bat".

## Installation

### Prerequisites

- Node.js 18+
- AWS credentials configured (via environment variables, AWS CLI, or IAM role)

### Install from source

    git clone <repository-url>
    cd ddbat
    npm install
    npm run build
    npm link  # makes 'ddbat' available globally

## Usage

All inputs come from flags or environment variables. Status messages go to stderr; JSON data goes to stdout, making it safe to pipe between commands.

    ddbat --help
    ddbat <command> --help

### Export

Export all or a filtered subset of a table to JSON lines by default, or use `--format json` for a JSON array. If the command is interrupted, DDBat finishes the current DynamoDB page, closes the output cleanly, and prints a `--start-key` cursor you can use to resume.

    # Export to stdout
    ddbat export --table users

    # Export to file
    ddbat export --table users --output users.json

    # Filter by partition key and sort key
    ddbat export --table orders --pk "customer-123" --sk ">= 2024-01-01"

    # Filter by expression
    ddbat export --table users --filter "status='active' AND age>18"

    # Resume from a previously printed cursor
    ddbat export --table users --start-key '{"userId":"123","createdAt":"2024-01-01"}'

### Import

Import JSON lines or a JSON array into a DynamoDB table. Input format is auto-detected by default, or you can override it with `--input-format jsonl` or `--input-format json`.

    # From file
    ddbat import --table users --input users.json

    # From stdin
    cat users.json | ddbat import --table users

Examples:

JSON array:

    [
      { "userId": "123", "name": "Alice" },
      { "userId": "456", "name": "Bob" }
    ]

JSON lines:

    { "userId": "123", "name": "Alice" }
    { "userId": "456", "name": "Bob" }

### Delete

Count matching items, show a forward-only preview page, and prompt for a per-page action before deleting. Use `--dry-run` to preview only, `--no-count` to skip the initial count pass, `--page-size` to control how many matching items appear on each page, `--start-key` to resume from a previously printed cursor, or `--force` to skip the prompt.

    # Preview without deleting
    ddbat delete --table users --pk "inactive" --dry-run

    # Delete with confirmation prompt (default)
    ddbat delete --table users --pk "inactive"

    # Skip the initial count query and preview 25 items per page
    ddbat delete --table users --pk "inactive" --no-count --page-size 25

    # Delete without prompt (for automation)
    ddbat delete --table users --pk "inactive" --force

    # Resume from a previously printed cursor
    ddbat delete --table users --pk "inactive" --start-key '{"userId":"123","createdAt":"2024-01-01"}'

    # Save deleted items to a backup file before removing them
    ddbat delete --table orders --filter "orderDate<'2023-01-01'" --force --format full > backup.json

Interactive delete actions:

- `all`: delete all remaining items from the current page through the end
- `d` (or `delete`): delete the current page, then continue to the next page
- `n` (or `next`): skip the current page and show the next page
- `q` (or `quit`): stop without deleting the current page or any later pages

If you press Ctrl-C during export or delete, DDBat completes the current page, prints a resume cursor to stderr, and stops. For delete, quitting from the interactive prompt also prints a resume cursor when there are later pages to process.

`--format` options:

| Value    | stdout output              |
| -------- | -------------------------- |
| (none)   | nothing                    |
| `full`   | full JSON of matched items |
| `keys`   | JSON array of keys only    |
| `count`  | item count as plain text   |
| `silent` | nothing (suppress stderr)  |

### Transform

Apply a JavaScript or TypeScript function to every item in a JSON stream. Reads from stdin and writes to stdout by default. Input format is auto-detected by default, or you can override it with `--input-format jsonl` or `--input-format json`. Output defaults to JSON lines, or use `--format json` for a JSON array.

#### How Transforms Work

- DDBat calls your function once per item.
- Function signature: `(item, index)`
- You can return sync or async results.
- Return an object to emit one item.
- Return an array of objects to emit many items (fan-out).
- Return `null` or `undefined` to drop the item.

#### Quick Usage

```bash
# Inline script: 'item' and 'index' are in scope; return the new item
ddbat transform --script 'const { ssn, ...safe } = item; return safe'

# Return null/undefined to drop an item
ddbat transform --script 'if (!item.active) return null; return item'

# Load a transform from a module file
ddbat transform --transform ./migrations/normalize.js

# From file, to file
ddbat transform --input data.json --transform ./migrations/add-field.js --output out.json
```

#### Transform File Template (JavaScript)

```js
export default function (item, index) {
  return {
    ...item,
    migratedAt: new Date().toISOString(),
    position: index,
  };
}
```

#### Transform File Template (TypeScript)

```ts
import type { TransformFn } from "ddbat/transform";

type Input = {
  id: string;
  email?: string;
  active?: boolean;
  ssn?: string;
};

type Output = {
  id: string;
  email?: string;
  migratedAt: string;
};

const transform: TransformFn<Input, Output> = (item) => {
  if (!item.active) return null;
  const { ssn, ...safe } = item;
  return {
    id: safe.id,
    email: safe.email,
    migratedAt: new Date().toISOString(),
  };
};

export default transform;
```

#### Common Transform Patterns

```bash
# Rename a field
ddbat transform --script 'const { userId, ...rest } = item; return { id: userId, ...rest }'

# Add default values
ddbat transform --script 'return { status: "active", ...item }'

# Fan-out one record into multiple records
ddbat transform --script 'return (item.tags || []).map(tag => ({ ...item, tag }))'
```

#### Test a Transform Safely

```bash
# 1) Export a small sample
ddbat export --table users --filter "status='active'" --output sample.json

# 2) Run transform locally
ddbat transform --input sample.json --transform ./migrations/normalize.js --output sample.out.json

# 3) Inspect results before importing
cat sample.out.json
```

TypeScript transform files require Node.js 22.6+ (native TypeScript support).

Limitations:

- Use ESM syntax (`export default`)
- Avoid `enum`, parameter properties, decorators, and `tsconfig` path aliases
- Compile to `.js` first if you need unsupported TS features

### Pipelines

Commands compose naturally with Unix pipes:

    # Copy a table
    ddbat export --table source | ddbat import --table destination

    # Copy with filtering
    ddbat export --table users --filter "status='active'" | ddbat import --table active-users

    # Copy with transform
    ddbat export --table users \
      | ddbat transform --transform ./migrations/normalize.js \
      | ddbat import --table users-v2

    # Multi-step transform
    ddbat export --table users \
      | ddbat transform --script 'const { ssn, ...s } = item; return s' \
      | ddbat transform --transform ./migrations/add-timestamps.js \
      | ddbat import --table users-clean

## Filtering

`--pk`, `--sk`, `--index`, and `--filter` work on `export` and `delete`.

### `--pk`

Partition key value (equality only):

    --pk "user-123"

### `--sk`

Sort key with optional operator. Spacing is flexible:

    --sk "2024-01-01"            # equals
    --sk ">= 2024-01-01"         # greater than or equal
    --sk "begins_with(2024-)"    # prefix
    --sk "between(100,200)"      # range

Supported operators: `=`, `<`, `<=`, `>`, `>=`, `begins_with(...)`, `between(...,...)`

### `--index`

Query or scan a secondary index (GSI or LSI):

    --index "StatusIndex"

### `--filter`

Filter expression for non-key attributes. Values are inlined and automatically parameterized to avoid reserved word conflicts.

    --filter "status='active'"
    --filter "age>=18 AND status IN ('active','pending')"
    --filter "attribute_exists(email)"
    --filter "begins_with(title,'Intro')"

Supported: `=`, `!=`, `<`, `<=`, `>`, `>=`, `begins_with`, `contains`, `between`, `attribute_exists`, `attribute_not_exists`, `size`, `IN`, `AND`, `OR`

## Environment Variables

    export DDBAT_TABLE=my-table   # Default table for export, import, delete

## Debugging

    DEBUG=1 ddbat export --table users

Prints full error stack traces to stderr.

## Shell Completion

DDBat supports shell completion via [Carapace](https://carapace-sh.github.io/carapace-bin/):

    brew install carapace   # macOS
    ddbat completion      # install the completion spec

Restart your shell, then use Tab to complete commands and flags.
