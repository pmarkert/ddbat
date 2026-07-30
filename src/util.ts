import {
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  QueryCommandOutput,
  ScanCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { getErrorMessage } from "./error.js";
import { DdbatItem } from "./transform-types.js";

let _dynamoClient: DynamoDBDocumentClient | null = null;
export const dynamoClient = (() => {
  if (_dynamoClient) return _dynamoClient;
  try {
    _dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    return _dynamoClient;
  } catch (err) {
    // Throw a clearer error that will be picked up by the centralized handler
    throw new Error(`Failed to create DynamoDB client: ${getErrorMessage(err)}`, {
      cause: err,
    });
  }
})();

export interface QueryOptions {
  partitionKey?: { name: string; value: unknown };
  sortKey?: { name: string; operator: string; value: unknown; value2?: unknown };
  indexName?: string;
  scanIndexForward?: boolean;
  filterExpression?: string;
  filterAttributes?: DdbatItem;
  filterAttributeNames?: Record<string, string>;
}

export interface KeySchema {
  partitionKey: string;
  sortKey?: string;
}

export interface QueryPage {
  items: DdbatItem[];
  lastEvaluatedKey?: DdbatItem;
}

interface DescribeTableKeySchema {
  AttributeName?: string;
  KeyType?: "HASH" | "RANGE" | string;
}

interface QueryRequestOptions {
  exclusiveStartKey?: DdbatItem;
  limit?: number;
  select?: "COUNT";
}

function buildQueryRequest(options: QueryOptions) {
  const {
    partitionKey,
    sortKey,
    indexName,
    scanIndexForward,
    filterExpression,
    filterAttributes,
    filterAttributeNames,
  } = options;

  let KeyConditionExpression: string | undefined;
  const ExpressionAttributeNames: Record<string, string> = {};
  const ExpressionAttributeValues: DdbatItem = {};

  if (partitionKey) {
    const pkPlaceholder = `#${partitionKey.name}`;
    const pkValuePlaceholder = `:${partitionKey.name}`;
    ExpressionAttributeNames[pkPlaceholder] = partitionKey.name;
    ExpressionAttributeValues[pkValuePlaceholder] = partitionKey.value;
    KeyConditionExpression = `${pkPlaceholder} = ${pkValuePlaceholder}`;

    if (sortKey) {
      const skPlaceholder = `#${sortKey.name}`;
      const skValuePlaceholder = `:${sortKey.name}`;
      ExpressionAttributeNames[skPlaceholder] = sortKey.name;
      ExpressionAttributeValues[skValuePlaceholder] = sortKey.value;

      switch (sortKey.operator) {
        case "=":
          KeyConditionExpression += ` AND ${skPlaceholder} = ${skValuePlaceholder}`;
          break;
        case "<":
          KeyConditionExpression += ` AND ${skPlaceholder} < ${skValuePlaceholder}`;
          break;
        case "<=":
          KeyConditionExpression += ` AND ${skPlaceholder} <= ${skValuePlaceholder}`;
          break;
        case ">":
          KeyConditionExpression += ` AND ${skPlaceholder} > ${skValuePlaceholder}`;
          break;
        case ">=":
          KeyConditionExpression += ` AND ${skPlaceholder} >= ${skValuePlaceholder}`;
          break;
        case "begins_with":
          KeyConditionExpression += ` AND begins_with(${skPlaceholder}, ${skValuePlaceholder})`;
          break;
        case "between": {
          const skValuePlaceholder2 = `:${sortKey.name}2`;
          ExpressionAttributeValues[skValuePlaceholder2] = sortKey.value2;
          KeyConditionExpression += ` AND ${skPlaceholder} BETWEEN ${skValuePlaceholder} AND ${skValuePlaceholder2}`;
          break;
        }
        default:
          throw new Error(`Unsupported sort key operator: ${sortKey.operator}`);
      }
    }
  }

  if (filterAttributes) {
    for (const [key, value] of Object.entries(filterAttributes)) {
      const valuePlaceholder = `:${key}`;
      ExpressionAttributeValues[valuePlaceholder] = value;
    }
  }

  // Explicit attribute name mappings (e.g. from between/contains where value keys differ from field name)
  if (filterAttributeNames) {
    for (const [placeholder, name] of Object.entries(filterAttributeNames)) {
      if (!ExpressionAttributeNames[placeholder]) {
        ExpressionAttributeNames[placeholder] = name;
      }
    }
  } else if (filterAttributes) {
    // Fallback: derive name placeholders from value keys (works for simple equality/comparison cases)
    for (const key of Object.keys(filterAttributes)) {
      const namePlaceholder = `#${key}`;
      if (!ExpressionAttributeNames[namePlaceholder]) {
        ExpressionAttributeNames[namePlaceholder] = key;
      }
    }
  }

  return {
    indexName,
    scanIndexForward,
    filterExpression,
    keyConditionExpression: KeyConditionExpression,
    expressionAttributeNames: ExpressionAttributeNames,
    expressionAttributeValues: ExpressionAttributeValues,
  };
}

async function executeQueryRequest(
  TableName: string,
  options: QueryOptions,
  requestOptions: QueryRequestOptions = {}
): Promise<QueryCommandOutput | ScanCommandOutput> {
  const {
    indexName,
    scanIndexForward,
    filterExpression,
    keyConditionExpression,
    expressionAttributeNames,
    expressionAttributeValues,
  } = buildQueryRequest(options);

  const sharedInput = {
    TableName,
    ...(Object.keys(expressionAttributeNames).length > 0 && {
      ExpressionAttributeNames: expressionAttributeNames,
    }),
    ...(Object.keys(expressionAttributeValues).length > 0 && {
      ExpressionAttributeValues: expressionAttributeValues,
    }),
    ...(filterExpression && { FilterExpression: filterExpression }),
    ...(requestOptions.exclusiveStartKey && {
      ExclusiveStartKey: requestOptions.exclusiveStartKey,
    }),
    ...(requestOptions.limit !== undefined && { Limit: requestOptions.limit }),
    ...(requestOptions.select && { Select: requestOptions.select }),
  };

  if (keyConditionExpression) {
    return dynamoClient.send(
      new QueryCommand({
        ...sharedInput,
        ...(indexName && { IndexName: indexName }),
        ...(scanIndexForward !== undefined && { ScanIndexForward: scanIndexForward }),
        KeyConditionExpression: keyConditionExpression,
      })
    );
  }

  return dynamoClient.send(
    new ScanCommand({
      ...sharedInput,
      ...(indexName && { IndexName: indexName }),
    })
  );
}

/**
 * Get list of all DynamoDB table names in the account
 */
export async function getTableNames(): Promise<string[]> {
  const tables: string[] = [];
  let lastEvaluatedTableName: string | undefined;

  do {
    const command = new ListTablesCommand({
      ExclusiveStartTableName: lastEvaluatedTableName,
    });
    const response = await new DynamoDBClient({}).send(command);

    if (response.TableNames) {
      tables.push(...response.TableNames);
    }
    lastEvaluatedTableName = response.LastEvaluatedTableName;
  } while (lastEvaluatedTableName);

  return tables;
}

export async function* queryTable(
  TableName: string,
  options: QueryOptions = {}
): AsyncGenerator<DdbatItem> {
  let lastEvaluatedKey: DdbatItem | undefined = undefined;

  do {
    const response = await executeQueryRequest(TableName, options, {
      exclusiveStartKey: lastEvaluatedKey,
    });
    for (const item of response.Items || []) {
      yield item;
    }
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);
}

export async function queryTablePage(
  TableName: string,
  options: QueryOptions = {},
  pageSize: number,
  exclusiveStartKey?: DdbatItem
): Promise<QueryPage> {
  if (pageSize < 1) {
    throw new Error("Page size must be at least 1");
  }

  const response = await executeQueryRequest(TableName, options, {
    exclusiveStartKey,
    limit: pageSize,
  });

  const lastEvaluatedKey = response.LastEvaluatedKey;

  return {
    items: response.Items || [],
    lastEvaluatedKey,
  };
}

export async function countTable(
  TableName: string,
  options: QueryOptions = {},
  exclusiveStartKey?: DdbatItem
): Promise<number> {
  let totalCount = 0;
  let lastEvaluatedKey: DdbatItem | undefined = exclusiveStartKey;

  do {
    const response = await executeQueryRequest(TableName, options, {
      exclusiveStartKey: lastEvaluatedKey,
      select: "COUNT",
    });

    totalCount += response.Count || 0;
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return totalCount;
}

function parseKeySchema(
  source: DescribeTableKeySchema[] | undefined,
  sourceDescription: string
): KeySchema {
  if (!source || source.length === 0) {
    throw new Error(`Could not retrieve key schema for ${sourceDescription}`);
  }

  const keySchema: KeySchema = { partitionKey: "" };

  for (const key of source) {
    if (key.KeyType === "HASH") {
      keySchema.partitionKey = key.AttributeName!;
    } else if (key.KeyType === "RANGE") {
      keySchema.sortKey = key.AttributeName!;
    }
  }

  if (!keySchema.partitionKey) {
    throw new Error(`Could not find partition key for ${sourceDescription}`);
  }

  return keySchema;
}

export async function getQueryKeySchema(tableName: string, indexName?: string): Promise<KeySchema> {
  const describeCommand = new DescribeTableCommand({
    TableName: tableName,
  });

  const response = await dynamoClient.send(describeCommand);
  const table = response.Table;

  if (!table) {
    throw new Error(`Could not retrieve table description for table ${tableName}`);
  }

  if (!indexName) {
    return parseKeySchema(table.KeySchema, `table ${tableName}`);
  }

  const gsi = table.GlobalSecondaryIndexes?.find((index) => index.IndexName === indexName);
  if (gsi) {
    return parseKeySchema(gsi.KeySchema, `index ${indexName} on table ${tableName}`);
  }

  const lsi = table.LocalSecondaryIndexes?.find((index) => index.IndexName === indexName);
  if (lsi) {
    return parseKeySchema(lsi.KeySchema, `index ${indexName} on table ${tableName}`);
  }

  throw new Error(`Index ${indexName} was not found on table ${tableName}`);
}

/**
 * Get the key schema for a table using DescribeTable
 */
export async function getTableKeySchema(tableName: string): Promise<KeySchema> {
  return getQueryKeySchema(tableName);
}

/**
 * Extract primary key attributes from an item using the table's key schema
 */
export function extractKeys(item: DdbatItem, keySchema: KeySchema): DdbatItem {
  const keys: DdbatItem = {};

  const missingKeys: string[] = [];

  // Extract partition key
  if (item[keySchema.partitionKey] === undefined) {
    missingKeys.push(keySchema.partitionKey);
  } else {
    keys[keySchema.partitionKey] = item[keySchema.partitionKey];
  }

  // Extract sort key if it exists
  if (keySchema.sortKey) {
    if (item[keySchema.sortKey] === undefined) {
      missingKeys.push(keySchema.sortKey);
    } else {
      keys[keySchema.sortKey] = item[keySchema.sortKey];
    }
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `Matched item is missing required table key attribute${missingKeys.length === 1 ? "" : "s"}: ${missingKeys.join(", ")}. ` +
        "If you are scanning or querying a secondary index, ensure its projection includes the base table primary key attributes."
    );
  }

  return keys;
}
