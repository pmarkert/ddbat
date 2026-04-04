import { Command } from "commander";

import { DdbatItem } from "./transform-types.js";
import { KeySchema, QueryOptions } from "./util.js";

/**
 * Adds filter options to a command for querying/scanning DynamoDB tables
 */
export function addFilterOptions(command: Command): Command {
  return command
    .option(
      "--pk [key]",
      "Partition key filter. Provide the partition key value (equality only). Example: --pk 123 or --pk user-123"
    )
    .option(
      "--sk [key]",
      "Sort key filter. Supported formats: 'value' (equals), 'operator value' (e.g. '>= 100', '< 50'), 'begins_with(prefix)' (also: beginsWith, starts_with, startsWith), and 'between(val1,val2)'. Examples: --sk 2023-01-01 --sk '>= 100' --sk 'begins_with(2023-)' --sk 'between(100,200)'"
    )
    .option(
      "--index [indexName]",
      "Index name to query (GSI/LSI). Use when querying a secondary index. Example: --index MyGSI"
    )
    .option(
      "--filter [expression]",
      "Additional filter expression for non-key attributes. Supports comparisons (=, !=, <, <=, >, >=), functions (begins_with, contains, between, attribute_exists, attribute_not_exists, size), IN operator, and AND/OR. Examples: --filter \"status='open' AND score>=10\" or --filter \"contains(tags,'premium')\""
    );
}

export interface FilterCommandOptions {
  pk?: string;
  sk?: string;
  index?: string;
  filter?: string;
}

/**
 * Parses command line filter options into QueryOptions
 * Requires keySchema to infer attribute names from table structure
 */
export function parseFilterOptions(
  options: FilterCommandOptions,
  keySchema: KeySchema
): QueryOptions {
  const queryOptions: QueryOptions = {};

  // Parse partition key
  // Supports formats:
  // - "value" (assumes = operator)
  // - "=:value" (explicit = operator)
  if (options.pk) {
    const input = options.pk;
    // Partition key only supports equality; use the raw value. If the user
    // needs to include leading operators in the value, they should quote it.
    queryOptions.partitionKey = {
      name: keySchema.partitionKey,
      value: input,
    };
  }

  // If a sort key filter was provided without a partition key, that's invalid
  // because DynamoDB Query operations require the partition key. Return an
  // explicit error to inform the user instead of silently performing a scan.
  if (options.sk && !options.pk) {
    throw new Error("Sort key filter (--sk) requires a partition key (--pk).");
  }

  // Parse sort key
  // Supports formats:
  // - "value" (assumes = operator)
  // - "operator:value" (e.g., ">=:100", "<:50")
  // - "between:value1:value2"
  // - "begins_with:value" (also beginsWith / starts_with / startsWith)
  if (options.sk) {
    const input = options.sk;

    if (!keySchema.sortKey) {
      throw new Error("Table does not have a sort key");
    }

    const name = keySchema.sortKey;

    if (/^between\(/i.test(input)) {
      const m = input.match(/^between\(([^,]+),\s*([^)]+)\)$/i);
      if (!m) {
        throw new Error("Invalid between format. Use: between(val1,val2)");
      }
      queryOptions.sortKey = {
        name,
        operator: "between",
        value: m[1].trim(),
        value2: m[2].trim(),
      };
    } else if (/^(?:begins_with|beginsWith|starts_with|startsWith)\(/i.test(input)) {
      const m = input.match(/^(?:begins_with|beginsWith|starts_with|startsWith)\(([^)]+)\)$/i);
      if (!m) {
        throw new Error(
          "Invalid starts-with format. Use: begins_with(prefix), beginsWith(prefix), starts_with(prefix), or startsWith(prefix)"
        );
      }
      let val = m[1].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.substring(1, val.length - 1);
      }
      queryOptions.sortKey = {
        name,
        operator: "begins_with",
        value: val,
      };
    } else {
      // Check for comparison operators. Allow optional space or colon after operator
      // Examples: '>=100', '>= 100', '>=:100' (colon kept for backwards-compat)
      const operatorMatch = input.match(/^(<=|>=|<|>|=)[:\s]?(.*)$/);
      if (operatorMatch) {
        queryOptions.sortKey = {
          name,
          operator: operatorMatch[1],
          value: operatorMatch[2].trim(),
        };
      } else {
        // No operator, assume equality
        queryOptions.sortKey = {
          name,
          operator: "=",
          value: input,
        };
      }
    }
  }

  // Add index name
  if (options.index) {
    queryOptions.indexName = options.index;
  }

  // Add filter expression
  if (options.filter) {
    // Normalize simple filter expressions into Dynamo-safe placeholders
    // e.g. type='goal'  ->  #type = :type  with filterAttributes { type: 'goal' }
    const { expression, attributes } = normalizeFilterExpression(options.filter);
    queryOptions.filterExpression = expression;
    queryOptions.filterAttributes = attributes;
  }

  return queryOptions;
}

/**
 * Convert a user-friendly filter string into an expression using
 * ExpressionAttributeNames (#+name) and ExpressionAttributeValues (:+name).
 * Supports simple comparison clauses and starts-with aliases:
 * begins_with(...), beginsWith(...), starts_with(...), startsWith(...).
 */
function normalizeFilterExpression(filter: string): {
  expression: string;
  attributes: DdbatItem;
} {
  const attributes: DdbatItem = {};

  // Split on AND/OR while keeping the separators
  const parts = filter.split(/(\s+(?:AND|OR)\s+)/i);

  const parsedParts = parts.map((part) => {
    const trimmed = part.trim();

    // Preserve separators (AND/OR)
    if (/^(AND|OR)$/i.test(trimmed)) return trimmed;

    // attribute_exists(attr) - pass through with attribute name placeholder
    const existsMatch = trimmed.match(/^attribute_exists\((\w+)\)$/i);
    if (existsMatch) {
      const field = existsMatch[1];
      return `attribute_exists(#${field})`;
    }

    // attribute_not_exists(attr) - pass through with attribute name placeholder
    const notExistsMatch = trimmed.match(/^attribute_not_exists\((\w+)\)$/i);
    if (notExistsMatch) {
      const field = notExistsMatch[1];
      return `attribute_not_exists(#${field})`;
    }

    // starts-with function styles: begins_with/beginsWith/starts_with/startsWith(attr, val)
    const beginsMatch = trimmed.match(
      /^(?:begins_with|beginsWith|starts_with|startsWith)\((\w+)\s*,\s*(.+)\)$/i
    );
    if (beginsMatch) {
      const field = beginsMatch[1];
      let val = beginsMatch[2].trim();
      // Remove surrounding quotes if present
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.substring(1, val.length - 1);
      }
      attributes[field] = parseValue(val);
      return `begins_with(#${field}, :${field})`;
    }

    // contains(attr, val) - check if string contains substring or set contains value
    const containsMatch = trimmed.match(/^contains\((\w+)\s*,\s*(.+)\)$/i);
    if (containsMatch) {
      const field = containsMatch[1];
      let val = containsMatch[2].trim();
      // Remove surrounding quotes if present
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.substring(1, val.length - 1);
      }
      attributes[field] = parseValue(val);
      return `contains(#${field}, :${field})`;
    }

    // between(attr, val1, val2) - check if value is between two values
    const betweenMatch = trimmed.match(/^between\((\w+)\s*,\s*([^,]+)\s*,\s*(.+)\)$/i);
    if (betweenMatch) {
      const field = betweenMatch[1];
      let val1 = betweenMatch[2].trim();
      let val2 = betweenMatch[3].trim();
      // Remove surrounding quotes if present
      if (
        (val1.startsWith('"') && val1.endsWith('"')) ||
        (val1.startsWith("'") && val1.endsWith("'"))
      ) {
        val1 = val1.substring(1, val1.length - 1);
      }
      if (
        (val2.startsWith('"') && val2.endsWith('"')) ||
        (val2.startsWith("'") && val2.endsWith("'"))
      ) {
        val2 = val2.substring(1, val2.length - 1);
      }
      attributes[`${field}_between1`] = parseValue(val1);
      attributes[`${field}_between2`] = parseValue(val2);
      return `#${field} BETWEEN :${field}_between1 AND :${field}_between2`;
    }

    // size(attr) comparisons - e.g., size(name)>10
    const sizeMatch = trimmed.match(/^size\((\w+)\)\s*(=|!=|<=|>=|<|>)\s*(.+)$/i);
    if (sizeMatch) {
      const field = sizeMatch[1];
      const op = sizeMatch[2];
      let val = sizeMatch[3].trim();
      // Remove surrounding quotes if present (though size typically compares to numbers)
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.substring(1, val.length - 1);
      }
      attributes[`${field}_size`] = parseValue(val);
      return `size(#${field}) ${op} :${field}_size`;
    }

    // IN operator - e.g., status IN ('active','pending','approved')
    const inMatch = trimmed.match(/^(\w+)\s+IN\s*\((.+)\)$/i);
    if (inMatch) {
      const field = inMatch[1];
      const valuesStr = inMatch[2];
      // Split by comma and parse each value
      const values = valuesStr.split(",").map((v) => {
        let val = v.trim();
        // Remove surrounding quotes if present
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.substring(1, val.length - 1);
        }
        return parseValue(val);
      });
      // Create placeholders for each value
      const placeholders = values.map((val, idx) => {
        const placeholder = `${field}_in${idx}`;
        attributes[placeholder] = val;
        return `:${placeholder}`;
      });
      return `#${field} IN (${placeholders.join(", ")})`;
    }

    // comparison operators
    const compMatch = trimmed.match(/^(\w+)\s*(=|!=|<=|>=|<|>)\s*(.+)$/);
    if (compMatch) {
      const field = compMatch[1];
      const op = compMatch[2];
      let val = compMatch[3].trim();

      // Strip quotes for literal strings
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.substring(1, val.length - 1);
      }

      attributes[field] = parseValue(val);
      return `#${field} ${op} :${field}`;
    }

    // If nothing matched, return original part (Dynamo placeholders may already be used)
    return part;
  });

  return { expression: parsedParts.join(" "), attributes };
}

function parseValue(val: string) {
  // Try to parse booleans
  if (val === "true") return true;
  if (val === "false") return false;

  // Try to parse null
  if (val === "null") return null;

  // Try to parse numbers
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);

  // Otherwise treat as string
  return val;
}
