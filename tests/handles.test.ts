import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  closeHandle,
  createHandleIdempotent,
  fingerprintInput,
  HANDLE_CONTENTION,
  HANDLE_ERROR,
  HandleStoreError,
  IDEMPOTENCY_CONFLICT,
  mintHandleId,
  replayKey,
  resolveHandle,
  transitionHandleIdempotent,
  type HandleRecord,
} from "../src/handles.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const NOW = Math.floor(Date.now() / 1000);
const OWNER = "client-a";
const KIND = "dataset-cursor";

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function handle(overrides: Partial<HandleRecord> = {}): HandleRecord {
  return {
    pk: "h_x",
    itemType: "handle",
    owner: OWNER,
    kind: KIND,
    state: { offset: 0 },
    status: "open",
    version: 0,
    expiresAt: NOW + 600,
    ...overrides,
  };
}

function replay<T>(
  tool: string,
  idempotencyKey: string,
  input: unknown,
  response: T,
  overrides: Record<string, unknown> = {},
) {
  return {
    pk: replayKey(OWNER, tool, idempotencyKey),
    itemType: "replay",
    owner: OWNER,
    tool,
    inputHash: fingerprintInput(input),
    response,
    expiresAt: NOW + 600,
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  process.env.HANDLES_TABLE = "handles-test";
  process.env.HANDLE_TTL_SECONDS = "900";
});

describe("identifier derivation", () => {
  it("produces 128-bit base64url handle ids", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => mintHandleId()));
    expect(ids.size).toBe(5000);
    for (const id of ids) expect(id).toMatch(/^h_[A-Za-z0-9_-]{22}$/);
  });

  it("canonicalizes input and never exposes the raw idempotency key", () => {
    expect(fingerprintInput({ b: 2, a: 1 })).toBe(
      fingerprintInput({ a: 1, b: 2 }),
    );
    const key = replayKey(OWNER, "dataset_open", "raw-secret-key");
    expect(key).toMatch(/^r_[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain("raw-secret-key");
  });
});

describe("createHandleIdempotent", () => {
  const operation = () => ({
    owner: OWNER,
    kind: KIND,
    tool: "dataset_open",
    idempotencyKey: "open-key-123",
    input: { dataset: "orders", pageSize: 10 },
    state: { dataset: "orders", pageSize: 10, offset: 0 },
    response: (handleId: string, expiresAt: number) => ({
      handle_id: handleId,
      expires_at: expiresAt,
    }),
  });

  it("atomically writes an owner-bound handle and replay result", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await createHandleIdempotent(operation());
    expect(result.replayed).toBe(false);
    expect(result.response.handle_id).toMatch(/^h_/);

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const handlePut = transaction.TransactItems?.[0].Put;
    const replayPut = transaction.TransactItems?.[1].Put;
    expect(handlePut?.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(handlePut?.Item).toMatchObject({
      itemType: "handle",
      owner: OWNER,
      kind: KIND,
      status: "open",
      version: 0,
    });
    expect(replayPut?.ConditionExpression).toBe(
      "attribute_not_exists(pk) OR expiresAt <= :now",
    );
    expect(replayPut?.Item).toMatchObject({
      itemType: "replay",
      owner: OWNER,
      tool: "dataset_open",
      response: result.response,
    });
    expect(JSON.stringify(replayPut?.Item)).not.toContain("open-key-123");
  });

  it("returns the original response for the same key and input", async () => {
    const response = { handle_id: "h_original", expires_at: NOW + 600 };
    ddbMock.on(GetCommand).resolves({
      Item: replay("dataset_open", "open-key-123", operation().input, response),
    });

    await expect(createHandleIdempotent(operation())).resolves.toEqual({
      response,
      replayed: true,
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("rejects reuse of a key with different input", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: replay(
        "dataset_open",
        "open-key-123",
        { dataset: "other", pageSize: 10 },
        { handle_id: "h_other" },
      ),
    });

    await expect(createHandleIdempotent(operation())).rejects.toMatchObject({
      code: IDEMPOTENCY_CONFLICT,
    });
  });

  it("recovers a committed replay after an ambiguous write failure", async () => {
    const response = { handle_id: "h_committed", expires_at: NOW + 600 };
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: undefined })
      .resolves({
        Item: replay("dataset_open", "open-key-123", operation().input, response),
      });
    ddbMock.on(TransactWriteCommand).rejects(awsError("TimeoutError"));

    await expect(createHandleIdempotent(operation())).resolves.toEqual({
      response,
      replayed: true,
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("propagates a non-retryable DynamoDB failure", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteCommand).rejects(awsError("AccessDeniedException"));

    await expect(createHandleIdempotent(operation())).rejects.toMatchObject({
      name: "AccessDeniedException",
    });
  });
});

describe("resolveHandle", () => {
  it("returns a live owner-bound handle", async () => {
    ddbMock.on(GetCommand).resolves({ Item: handle() });
    await expect(resolveHandle(OWNER, "h_x", KIND)).resolves.toMatchObject({
      state: { offset: 0 },
      version: 0,
    });
  });

  it.each([
    ["missing", undefined],
    ["foreign", handle({ owner: "client-b" })],
    ["wrong kind", handle({ kind: "other" })],
    ["expired", handle({ expiresAt: NOW - 5 })],
    ["legacy shape", { pk: "h_x", owner: OWNER, kind: KIND, expiresAt: NOW + 5 }],
  ])("fails opaquely for %s handles", async (_label, item) => {
    ddbMock.on(GetCommand).resolves({ Item: item as never });
    await expect(resolveHandle(OWNER, "h_x", KIND)).rejects.toMatchObject({
      code: HANDLE_ERROR,
    });
  });
});

describe("transitionHandleIdempotent", () => {
  const operation = () => ({
    owner: OWNER,
    handleId: "h_x",
    kind: KIND,
    tool: "dataset_next",
    idempotencyKey: "next-key-123",
    input: { handleId: "h_x" },
    transition: (record: HandleRecord) => {
      const offset = Number(record.state.offset);
      return {
        state: { offset: offset + 10 },
        status: "open" as const,
        response: { offset, rows: [offset], done: false },
      };
    },
  });

  it("atomically advances the expected version and stores the response", async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: undefined })
      .resolvesOnce({ Item: handle() });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await transitionHandleIdempotent(operation());
    expect(result).toEqual({
      response: { offset: 0, rows: [0], done: false },
      replayed: false,
    });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const update = transaction.TransactItems?.[0].Update;
    expect(update?.ConditionExpression).toContain("#version = :version");
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ":owner": OWNER,
      ":kind": KIND,
      ":version": 0,
      ":nextVersion": 1,
    });
    expect(transaction.TransactItems?.[1].Put?.Item?.response).toEqual(
      result.response,
    );
  });

  it("returns a stored page without resolving or advancing the handle", async () => {
    const response = { offset: 0, rows: [0], done: false };
    ddbMock.on(GetCommand).resolves({
      Item: replay("dataset_next", "next-key-123", operation().input, response),
    });

    await expect(transitionHandleIdempotent(operation())).resolves.toEqual({
      response,
      replayed: true,
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("makes concurrent same-key calls converge after the loser rereads", async () => {
    let storedHandle = handle();
    let storedReplay: Record<string, unknown> | undefined;
    let winningTransaction: any;
    let releaseWinner!: () => void;
    const loserHasArrived = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let transactionAttempts = 0;

    ddbMock.on(GetCommand).callsFake((input) => {
      const pk = String(input.Key?.pk);
      return pk.startsWith("r_")
        ? { Item: storedReplay }
        : { Item: structuredClone(storedHandle) };
    });
    ddbMock.on(TransactWriteCommand).callsFake(async (input) => {
      transactionAttempts += 1;
      if (transactionAttempts === 1) {
        winningTransaction = input;
        await loserHasArrived;
        return {};
      }

      const update = winningTransaction.TransactItems?.[0].Update;
      storedHandle = {
        ...storedHandle,
        state: update.ExpressionAttributeValues[":state"],
        status: update.ExpressionAttributeValues[":status"],
        version: update.ExpressionAttributeValues[":nextVersion"],
      };
      storedReplay = winningTransaction.TransactItems?.[1].Put?.Item;
      releaseWinner();
      throw awsError("TransactionCanceledException");
    });

    const [winner, loser] = await Promise.all([
      transitionHandleIdempotent(operation()),
      transitionHandleIdempotent(operation()),
    ]);

    expect(winner).toEqual({
      response: { offset: 0, rows: [0], done: false },
      replayed: false,
    });
    expect(loser).toEqual({ ...winner, replayed: true });
    expect(storedHandle).toMatchObject({ state: { offset: 10 }, version: 1 });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(5);
  });

  it("rereads the handle after another key wins the version race", async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: undefined })
      .resolvesOnce({ Item: handle() })
      .resolvesOnce({ Item: undefined })
      .resolvesOnce({ Item: handle({ state: { offset: 10 }, version: 1 }) });
    ddbMock
      .on(TransactWriteCommand)
      .rejectsOnce(awsError("TransactionCanceledException"))
      .resolves({});

    const result = await transitionHandleIdempotent(operation());
    expect(result.response).toEqual({ offset: 10, rows: [10], done: false });
    const transactions = ddbMock.commandCalls(TransactWriteCommand);
    expect(transactions).toHaveLength(2);
    expect(
      transactions[1].args[0].input.TransactItems?.[0].Update
        ?.ExpressionAttributeValues?.[":version"],
    ).toBe(1);
  });

  it("recovers the stored page after an ambiguous transition result", async () => {
    const response = { offset: 0, rows: [0], done: false };
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: undefined })
      .resolvesOnce({ Item: handle() })
      .resolves({
        Item: replay("dataset_next", "next-key-123", operation().input, response),
      });
    ddbMock.on(TransactWriteCommand).rejects(awsError("TimeoutError"));

    await expect(transitionHandleIdempotent(operation())).resolves.toEqual({
      response,
      replayed: true,
    });
  });

  it("returns a stable contention error after bounded retries", async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      const pk = String(input.Key?.pk);
      return pk.startsWith("r_") ? {} : { Item: handle() };
    });
    ddbMock
      .on(TransactWriteCommand)
      .rejects(awsError("TransactionCanceledException"));

    await expect(transitionHandleIdempotent(operation())).rejects.toMatchObject({
      code: HANDLE_CONTENTION,
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(6);
  });
});

describe("closeHandle", () => {
  it("conditions deletion on owner, kind, type, and live expiry", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await closeHandle(OWNER, "h_x", KIND);

    const input = ddbMock.commandCalls(DeleteCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain("expiresAt > :now");
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":handleType": "handle",
      ":owner": OWNER,
      ":kind": KIND,
    });
  });

  it("is a no-op only for a failed condition", async () => {
    ddbMock
      .on(DeleteCommand)
      .rejects(awsError("ConditionalCheckFailedException"));
    await expect(closeHandle("client-b", "h_x", KIND)).resolves.toBeUndefined();
  });

  it("propagates operational delete failures", async () => {
    ddbMock.on(DeleteCommand).rejects(awsError("AccessDeniedException"));
    await expect(closeHandle(OWNER, "h_x", KIND)).rejects.toMatchObject({
      name: "AccessDeniedException",
    });
  });
});

describe("HandleStoreError", () => {
  it("uses its stable code as the public message", () => {
    expect(new HandleStoreError(HANDLE_ERROR)).toMatchObject({
      name: "HandleStoreError",
      code: HANDLE_ERROR,
      message: HANDLE_ERROR,
    });
  });
});