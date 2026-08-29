// Protocol layer: the whole server module, in process.
//
// The module contract for Serverless v4 MCP hosting is a web-standard
// fetch(request) function. That makes the entire server testable with no
// Lambda emulator, no local API Gateway, and no deployed stack: construct
// a Request, call fetch, assert on the Response. DynamoDB stays mocked at
// the SDK command level, so the only untested seams are the managed
// services themselves.
//
// Requests carry the 2026-07-28 per-request envelope (protocol version,
// client info, client capabilities in params._meta) plus the revision's
// routing headers. There is no initialize handshake and no session id:
// every request here is self-contained, which is exactly the property
// that lets any Lambda instance serve any request.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  createDatasetModule,
  REQUIRED_SCOPE,
} from "../src/server.js";
import { fingerprintInput, replayKey } from "../src/handles.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const NOW = Math.floor(Date.now() / 1000);
const OPEN_KEY = "open-key-123";
const NEXT_KEY = "next-key-123";

const ENVELOPE = {
  "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function bearerFor(subject: string): string {
  return `verified:${subject}`;
}

const testVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    const match = /^verified:(.+)$/.exec(token);
    if (!match) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    }
    return {
      token,
      clientId: match[1],
      scopes: [REQUIRED_SCOPE],
      expiresAt: NOW + 600,
    };
  },
};

const mcpModule = createDatasetModule({ verifier: testVerifier });

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function handleItem(overrides: Record<string, unknown> = {}) {
  return {
    pk: "h_abc",
    itemType: "handle",
    owner: "client-a",
    kind: "dataset-cursor",
    state: { dataset: "orders", pageSize: 10, offset: 0 },
    status: "open",
    version: 0,
    expiresAt: NOW + 600,
    ...overrides,
  };
}

function mockReplayMissWithHandle(item: Record<string, unknown> | undefined) {
  ddbMock.on(GetCommand).callsFake((input) =>
    String(input.Key?.pk).startsWith("r_") ? {} : { Item: item },
  );
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  subject = "client-a",
): Request {
  return new Request("https://local/datasets/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearerFor(subject)}`,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, _meta: ENVELOPE },
    }),
  });
}

async function resultOf(res: Response): Promise<any> {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return JSON.parse(body.result.content[0].text);
}

beforeEach(() => {
  ddbMock.reset();
  process.env.HANDLES_TABLE = "handles-test";
  process.env.HANDLE_TTL_SECONDS = "900";
  process.env._X_AMZN_TRACE_ID =
    "Root=1-66b2a1c0-abcd1234ef567890abcd1234;Parent=1234567890abcdef;Sampled=1";
});

describe("stateless request handling", () => {
  it("rejects requests with no bearer token before the SDK runs", async () => {
    const res = await mcpModule.fetch(
      new Request("https://local/datasets/mcp", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a bearer token that the verifier does not trust", async () => {
    const res = await mcpModule.fetch(
      new Request("https://local/datasets/mcp", {
        method: "POST",
        headers: { authorization: "Bearer forged.jwt.value" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a verified token without the required scope", async () => {
    const moduleWithoutScope = createDatasetModule({
      verifier: {
        verifyAccessToken: async (token) => ({
          token,
          clientId: "client-a",
          scopes: [],
          expiresAt: NOW + 600,
        }),
      },
    });
    const res = await moduleWithoutScope.fetch(
      new Request("https://local/datasets/mcp", {
        method: "POST",
        headers: { authorization: "Bearer verified:client-a" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("advertises both accepted page_size representations", async () => {
    const response = await mcpModule.fetch(
      new Request("https://local/datasets/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearerFor("client-a")}`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: ENVELOPE },
        }),
      }),
    );
    const body = await response.json();
    const tool = body.result.tools.find(
      (candidate: { name: string }) => candidate.name === "dataset_open",
    );
    const alternatives = tool.inputSchema.properties.page_size.anyOf;

    expect(response.status).toBe(200);
    expect(alternatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "integer",
          minimum: 1,
          maximum: 50,
        }),
        expect.objectContaining({
          type: "string",
          pattern: "^(?:[1-9]|[1-4][0-9]|50)$",
        }),
      ]),
    );
  });

  it.each(["GET", "DELETE"])(
    "answers %s with 405, as a 2026-07-28 server should",
    async (method) => {
      const res = await mcpModule.fetch(
        new Request("https://local/datasets/mcp", {
          method,
          headers: { authorization: `Bearer ${bearerFor("client-a")}` },
        }),
      );
      expect(res.status).toBe(405);
    },
  );
});

describe("explicit-handle lifecycle", () => {
  it("dataset_open mints an owner-bound handle", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteCommand).resolves({});
    const out = await resultOf(
      await mcpModule.fetch(
        toolCall("dataset_open", {
          dataset: "orders",
          idempotency_key: OPEN_KEY,
        }),
      ),
    );
    expect(out.handle_id).toMatch(/^h_/);
    expect(out.total_rows).toBeGreaterThan(0);

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const handle = transaction.TransactItems?.[0].Put?.Item;
    expect(handle?.owner).toBe("client-a");
    expect(handle?.kind).toBe("dataset-cursor");
    expect(handle?.version).toBe(0);
  });

  it.each([20, "20"])(
    "accepts page_size %j and normalizes it to a number",
    async (pageSize) => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(TransactWriteCommand).resolves({});

      await resultOf(
        await mcpModule.fetch(
          toolCall("dataset_open", {
            dataset: "orders",
            page_size: pageSize,
            idempotency_key: OPEN_KEY,
          }),
        ),
      );

      const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      const handle = transaction.TransactItems?.[0].Put?.Item;
      expect(handle?.state).toMatchObject({ pageSize: 20 });
    },
  );

  it.each([true, " 20", "01", "20.5", "51"])(
    "rejects invalid page_size %j before accessing DynamoDB",
    async (pageSize) => {
      const response = await mcpModule.fetch(
        toolCall("dataset_open", {
          dataset: "orders",
          page_size: pageSize,
          idempotency_key: OPEN_KEY,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("Input validation error");
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it("dataset_open replays the original handle for the same key", async () => {
    const response = {
      handle_id: "h_original",
      total_rows: 75,
      expires_at: NOW + 600,
    };
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: replayKey("client-a", "dataset_open", OPEN_KEY),
        itemType: "replay",
        owner: "client-a",
        tool: "dataset_open",
        inputHash: fingerprintInput({ dataset: "orders", pageSize: 20 }),
        response,
        expiresAt: NOW + 600,
      },
    });

    const out = await resultOf(
      await mcpModule.fetch(
        toolCall("dataset_open", {
          dataset: "orders",
          idempotency_key: OPEN_KEY,
        }),
      ),
    );
    expect(out).toEqual(response);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("rejects changed input under a reused dataset_open key", async () => {
    const spy = vi.spyOn(console, "log");
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: replayKey("client-a", "dataset_open", OPEN_KEY),
        itemType: "replay",
        owner: "client-a",
        tool: "dataset_open",
        inputHash: fingerprintInput({ dataset: "orders", pageSize: 20 }),
        response: { handle_id: "h_original" },
        expiresAt: NOW + 600,
      },
    });

    const response = await mcpModule.fetch(
      toolCall("dataset_open", {
        dataset: "changed",
        idempotency_key: OPEN_KEY,
      }),
    );
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error).toBe(
      "idempotency_conflict",
    );
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);

    const entry = JSON.parse(
      spy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"tool_call"'))!,
    );
    expect(entry).toMatchObject({
      outcome: "idempotency_conflict",
      errorCode: "IDEMPOTENCY_CONFLICT",
    });
    spy.mockRestore();
  });

  it("dataset_next pages via the handle and advances the stored cursor", async () => {
    mockReplayMissWithHandle(handleItem());
    ddbMock.on(TransactWriteCommand).resolves({});

    const out = await resultOf(
      await mcpModule.fetch(
        toolCall("dataset_next", {
          handle_id: "h_abc",
          idempotency_key: NEXT_KEY,
        }),
      ),
    );
    expect(out.rows).toHaveLength(10);
    expect(out.done).toBe(false);

    const update = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input
      .TransactItems?.[0].Update;
    expect(update?.ExpressionAttributeValues?.[":owner"]).toBe("client-a");
    expect(update?.ExpressionAttributeValues?.[":nextVersion"]).toBe(1);
  });

  it("distinct dataset_next keys advance successive cursor versions", async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: undefined })
      .resolvesOnce({ Item: handleItem() })
      .resolvesOnce({ Item: undefined })
      .resolvesOnce({
        Item: handleItem({
          state: { dataset: "orders", pageSize: 10, offset: 10 },
          version: 1,
        }),
      });
    ddbMock.on(TransactWriteCommand).resolves({});

    const first = await resultOf(
      await mcpModule.fetch(
        toolCall("dataset_next", {
          handle_id: "h_abc",
          idempotency_key: "next-key-one",
        }),
      ),
    );
    const second = await resultOf(
      await mcpModule.fetch(
        toolCall("dataset_next", {
          handle_id: "h_abc",
          idempotency_key: "next-key-two",
        }),
      ),
    );

    expect(first.rows[0].id).toBe("orders-0001");
    expect(second.rows[0].id).toBe("orders-0011");
    const transactions = ddbMock.commandCalls(TransactWriteCommand);
    expect(
      transactions[0].args[0].input.TransactItems?.[0].Update
        ?.ExpressionAttributeValues?.[":version"],
    ).toBe(0);
    expect(
      transactions[1].args[0].input.TransactItems?.[0].Update
        ?.ExpressionAttributeValues?.[":version"],
    ).toBe(1);
  });

  it("a foreign caller presenting a valid handle gets the opaque error", async () => {
    mockReplayMissWithHandle(handleItem());
    const res = await mcpModule.fetch(
      toolCall(
        "dataset_next",
        { handle_id: "h_abc", idempotency_key: NEXT_KEY },
        "client-b",
      ),
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error).toBe("unknown_handle");
  });

  it("an expired handle behaves identically to a missing one", async () => {
    mockReplayMissWithHandle(
      handleItem({ pk: "h_old", expiresAt: NOW - 30 }),
    );
    const expired = await (
      await mcpModule.fetch(
        toolCall("dataset_next", {
          handle_id: "h_old",
          idempotency_key: "expired-key-123",
        }),
      )
    ).json();

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const missing = await (
      await mcpModule.fetch(
        toolCall("dataset_next", {
          handle_id: "h_zzz",
          idempotency_key: "missing-key-123",
        }),
      )
    ).json();

    expect(expired.result.content[0].text).toBe(missing.result.content[0].text);
  });

  it("dataset_close is idempotent for unknown handles", async () => {
    ddbMock
      .on(DeleteCommand)
      .rejects(awsError("ConditionalCheckFailedException"));
    const out = await resultOf(
      await mcpModule.fetch(toolCall("dataset_close", { handle_id: "h_gone" })),
    );
    expect(out.closed).toBe(true);
  });

  it("retains and replays the terminal page", async () => {
    mockReplayMissWithHandle(
      handleItem({ state: { dataset: "orders", pageSize: 50, offset: 50 } }),
    );
    ddbMock.on(TransactWriteCommand).resolves({});

    const request = () =>
      toolCall("dataset_next", {
        handle_id: "h_abc",
        idempotency_key: "terminal-key-123",
      });
    const first = await resultOf(await mcpModule.fetch(request()));
    expect(first.done).toBe(true);
    expect(first.rows.length).toBeGreaterThan(0);

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(
      transaction.TransactItems?.[0].Update?.ExpressionAttributeValues?.[":status"],
    ).toBe("exhausted");
    const storedReplay = transaction.TransactItems?.[1].Put?.Item;

    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({ Item: storedReplay });
    const repeated = await resultOf(await mcpModule.fetch(request()));
    expect(repeated).toEqual(first);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("verifiable tracing", () => {
  function capturedToolLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"tool_call"'));
  }

  it("emits exactly one structured line per tool call, never the arguments", async () => {
    const spy = vi.spyOn(console, "log");
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteCommand).resolves({});
    await mcpModule.fetch(
      toolCall("dataset_open", {
        dataset: "orders",
        idempotency_key: OPEN_KEY,
      }),
    );

    const lines = capturedToolLines(spy);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      msg: "tool_call",
      tool: "dataset_open",
      clientId: "client-a",
      requestId: 1,
      traceId: "1-66b2a1c0-abcd1234ef567890abcd1234",
      outcome: "ok",
      replayStatus: "fresh",
    });
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.operationDigest).toMatch(/^r_[A-Za-z0-9_-]{43}$/);
    expect(entry.handleId).toMatch(/^h_/);
    expect(typeof entry.durationMs).toBe("number");
    // The repudiation record must never carry argument values.
    expect(lines[0]).not.toContain("orders");
    expect(lines[0]).not.toContain(OPEN_KEY);
    spy.mockRestore();
  });

  it("records failed resolutions as a distinct unknown_handle outcome", async () => {
    const spy = vi.spyOn(console, "log");
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await mcpModule.fetch(
      toolCall("dataset_next", {
        handle_id: "h_probe",
        idempotency_key: NEXT_KEY,
      }),
    );

    const entry = JSON.parse(capturedToolLines(spy)[0]);
    expect(entry.outcome).toBe("unknown_handle");
    expect(entry.errorCode).toBe("UNKNOWN_HANDLE");
    expect(entry.handleId).toBe("h_probe"); // the probe itself is the evidence
    spy.mockRestore();
  });

  it("logs a security signal when a request reaches the module unauthenticated", async () => {
    const spy = vi.spyOn(console, "log");
    await mcpModule.fetch(
      new Request("https://local/datasets/mcp", { method: "POST", body: "{}" }),
    );
    const signals = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("module_auth_reject"));
    expect(signals).toHaveLength(1);
    spy.mockRestore();
  });
});
