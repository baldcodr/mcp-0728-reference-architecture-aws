// Handle store for the MCP 2026-07-28 explicit-handle pattern.
//
// The protocol core is stateless: nothing survives a request unless a tool
// mints a handle and the model passes it back on a later call. This module
// is the server side of that contract. Design rules, in order of importance:
//
//   1. Handle values are unpredictable. 128 bits from crypto.randomBytes,
//      base64url encoded. A guessable handle is a hijackable workflow.
//   2. Handles are bound to the caller. Every read, update, and delete
//      carries the verified Cognito client_id as a condition. A valid handle
//      presented by a different principal fails.
//   3. Missing, expired, and foreign handles are indistinguishable to the
//      caller. One error string, no existence oracle.
//   4. Expiry is enforced in code on every access. DynamoDB TTL is a
//      best-effort background sweep measured in days, not a security
//      control. TTL keeps the table small; the expiresAt comparison in
//      the condition expression keeps stale handles unusable.

import { createHash, randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import xray from "aws-xray-sdk-core";

export const HANDLE_ERROR = "unknown_handle";
export const IDEMPOTENCY_CONFLICT = "idempotency_conflict";
export const HANDLE_CONTENTION = "handle_contention";

export type HandleStoreErrorCode =
  | typeof HANDLE_ERROR
  | typeof IDEMPOTENCY_CONFLICT
  | typeof HANDLE_CONTENTION;

export class HandleStoreError extends Error {
  constructor(readonly code: HandleStoreErrorCode) {
    super(code);
    this.name = "HandleStoreError";
  }
}

export interface HandleRecord {
  pk: string;
  itemType: "handle";
  owner: string;
  kind: string;
  state: Record<string, unknown>;
  status: "open" | "exhausted";
  version: number;
  expiresAt: number;
}

interface ReplayRecord<T = unknown> {
  pk: string;
  itemType: "replay";
  owner: string;
  tool: string;
  inputHash: string;
  response: T;
  expiresAt: number;
}

export interface IdempotentResult<T> {
  response: T;
  replayed: boolean;
}

interface IdempotencyOperation {
  owner: string;
  tool: string;
  idempotencyKey: string;
  input: unknown;
}

interface CreateHandleOperation<T> extends IdempotencyOperation {
  kind: string;
  state: Record<string, unknown>;
  response: (handleId: string, expiresAt: number) => T;
}

interface HandleTransition<T> {
  state: Record<string, unknown>;
  status: HandleRecord["status"];
  response: T;
}

interface TransitionHandleOperation<T> extends IdempotencyOperation {
  handleId: string;
  kind: string;
  transition: (record: HandleRecord) => HandleTransition<T>;
}

// Every item command becomes an X-Ray subsegment, so a condition-check
// failure (a cross-tenant attempt, an expired handle) is visible as a
// trace, not only as a test assertion. The wrap applies only inside
// Lambda; locally and under vitest the raw client is used, so tests need
// no daemon and no trace context.
const rawClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(
  process.env.AWS_LAMBDA_FUNCTION_NAME
    ? xray.captureAWSv3Client(rawClient)
    : rawClient,
  { marshallOptions: { removeUndefinedValues: true } },
);

function tableName(): string {
  const t = process.env.HANDLES_TABLE;
  if (!t) throw new Error("HANDLES_TABLE is not set");
  return t;
}

function ttlSeconds(): number {
  const value = Number(process.env.HANDLE_TTL_SECONDS ?? 900);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("HANDLE_TTL_SECONDS must be a positive integer");
  }
  return value;
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export function mintHandleId(): string {
  return "h_" + randomBytes(16).toString("base64url");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("idempotency input is not JSON serializable");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function fingerprintInput(input: unknown): string {
  return sha256(canonicalJson(input));
}

export function replayKey(
  owner: string,
  tool: string,
  idempotencyKey: string,
): string {
  return `r_${sha256(`${owner}\0${tool}\0${idempotencyKey}`)}`;
}

function replayIdentity(operation: IdempotencyOperation) {
  return {
    pk: replayKey(
      operation.owner,
      operation.tool,
      operation.idempotencyKey,
    ),
    inputHash: fingerprintInput(operation.input),
  };
}

async function readReplay<T>(
  operation: IdempotencyOperation,
  identity = replayIdentity(operation),
): Promise<ReplayRecord<T> | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: identity.pk },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as ReplayRecord<T> | undefined;
  if (!item || item.expiresAt <= nowEpoch()) return undefined;
  if (
    item.itemType !== "replay" ||
    item.owner !== operation.owner ||
    item.tool !== operation.tool ||
    item.inputHash !== identity.inputHash ||
    !("response" in item)
  ) {
    throw new HandleStoreError(IDEMPOTENCY_CONFLICT);
  }
  return item;
}

function errorName(error: unknown): string | undefined {
  return error && typeof error === "object" && "name" in error
    ? String(error.name)
    : undefined;
}

function isRetryableTransactionFailure(error: unknown): boolean {
  const name = errorName(error);
  if (
    name === "TransactionCanceledException" ||
    name === "TransactionConflictException" ||
    name === "TimeoutError" ||
    name === "RequestTimeout" ||
    name === "NetworkingError"
  ) {
    return true;
  }
  if (error && typeof error === "object" && "$retryable" in error) {
    return Boolean(error.$retryable);
  }
  const status =
    error &&
    typeof error === "object" &&
    "$metadata" in error &&
    error.$metadata &&
    typeof error.$metadata === "object" &&
    "httpStatusCode" in error.$metadata
      ? Number(error.$metadata.httpStatusCode)
      : undefined;
  return status !== undefined && status >= 500;
}

function replayPut<T>(
  operation: IdempotencyOperation,
  identity: ReturnType<typeof replayIdentity>,
  response: T,
  expiresAt: number,
  now: number,
) {
  const item: ReplayRecord<T> = {
    pk: identity.pk,
    itemType: "replay",
    owner: operation.owner,
    tool: operation.tool,
    inputHash: identity.inputHash,
    response,
    expiresAt,
  };
  return {
    TableName: tableName(),
    Item: item,
    ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
    ExpressionAttributeValues: { ":now": now },
  };
}

export async function createHandleIdempotent<T>(
  operation: CreateHandleOperation<T>,
): Promise<IdempotentResult<T>> {
  const identity = replayIdentity(operation);
  const existing = await readReplay<T>(operation, identity);
  if (existing) return { response: existing.response, replayed: true };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = nowEpoch();
    const handleId = mintHandleId();
    const expiresAt = now + ttlSeconds();
    const response = operation.response(handleId, expiresAt);
    const handle: HandleRecord = {
      pk: handleId,
      itemType: "handle",
      owner: operation.owner,
      kind: operation.kind,
      state: operation.state,
      status: "open",
      version: 0,
      expiresAt,
    };

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName(),
                Item: handle,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: replayPut(operation, identity, response, expiresAt, now),
            },
          ],
        }),
      );
      return { response, replayed: false };
    } catch (error) {
      const replay = await readReplay<T>(operation, identity);
      if (replay) return { response: replay.response, replayed: true };
      if (!isRetryableTransactionFailure(error)) throw error;
    }
  }

  throw new HandleStoreError(HANDLE_CONTENTION);
}

export async function resolveHandle(
  owner: string,
  handleId: string,
  kind: string,
): Promise<HandleRecord> {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: handleId },
      ConsistentRead: true,
    }),
  );
  const item = res.Item as HandleRecord | undefined;
  if (
    !item ||
    item.itemType !== "handle" ||
    item.owner !== owner ||
    item.kind !== kind ||
    item.expiresAt <= nowEpoch() ||
    !Number.isSafeInteger(item.version) ||
    (item.status !== "open" && item.status !== "exhausted")
  ) {
    throw new HandleStoreError(HANDLE_ERROR);
  }
  return item;
}

export async function transitionHandleIdempotent<T>(
  operation: TransitionHandleOperation<T>,
): Promise<IdempotentResult<T>> {
  const identity = replayIdentity(operation);
  const existing = await readReplay<T>(operation, identity);
  if (existing) return { response: existing.response, replayed: true };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const record = await resolveHandle(
      operation.owner,
      operation.handleId,
      operation.kind,
    );
    const transition = operation.transition(record);
    const now = nowEpoch();

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName(),
                Key: { pk: operation.handleId },
                UpdateExpression:
                  "SET #state = :state, #status = :status, #version = :nextVersion",
                ConditionExpression:
                  "#itemType = :handleType AND #owner = :owner AND #kind = :kind AND #version = :version AND expiresAt > :now",
                ExpressionAttributeNames: {
                  "#itemType": "itemType",
                  "#owner": "owner",
                  "#kind": "kind",
                  "#state": "state",
                  "#status": "status",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":handleType": "handle",
                  ":owner": operation.owner,
                  ":kind": operation.kind,
                  ":version": record.version,
                  ":nextVersion": record.version + 1,
                  ":state": transition.state,
                  ":status": transition.status,
                  ":now": now,
                },
              },
            },
            {
              Put: replayPut(
                operation,
                identity,
                transition.response,
                record.expiresAt,
                now,
              ),
            },
          ],
        }),
      );
      return { response: transition.response, replayed: false };
    } catch (error) {
      const replay = await readReplay<T>(operation, identity);
      if (replay) return { response: replay.response, replayed: true };
      if (!isRetryableTransactionFailure(error)) throw error;
    }
  }

  const replay = await readReplay<T>(operation, identity);
  if (replay) return { response: replay.response, replayed: true };
  throw new HandleStoreError(HANDLE_CONTENTION);
}

export async function closeHandle(
  owner: string,
  handleId: string,
  kind: string,
): Promise<void> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { pk: handleId },
        ConditionExpression:
          "#itemType = :handleType AND #owner = :owner AND #kind = :kind AND expiresAt > :now",
        ExpressionAttributeNames: {
          "#itemType": "itemType",
          "#owner": "owner",
          "#kind": "kind",
        },
        ExpressionAttributeValues: {
          ":handleType": "handle",
          ":owner": owner,
          ":kind": kind,
          ":now": nowEpoch(),
        },
      }),
    );
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
  }
}
