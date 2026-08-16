// MCP server module (2026-07-28 stateless core).
//
// Three tools demonstrate the explicit-handle pattern end to end:
//
//   dataset_open  -> mints a handle over a paginated dataset (state: cursor)
//   dataset_next  -> resolves the handle, returns a page, advances the cursor
//   dataset_close -> deletes the handle
//
// No session, no Mcp-Session-Id, no in-memory state between invocations.
// Any Lambda instance can serve any request; continuity lives entirely in
// the handle the model threads from one call to the next.
//
// The default export verifies the bearer token again inside the module and
// passes the verified client identity into authInfo, which the SDK exposes to
// tools as ctx.http.authInfo. Tools never parse HTTP themselves.

import {
  createMcpHandler,
  McpServer,
  requireBearerAuth,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createHandleIdempotent,
  transitionHandleIdempotent,
  closeHandle,
  HandleStoreError,
  HANDLE_ERROR,
  IDEMPOTENCY_CONFLICT,
  HANDLE_CONTENTION,
  replayKey,
} from "./handles.js";
import { createCognitoTokenVerifierFromEnv } from "./identity.js";
import {
  toolLog,
  securityLog,
  type ToolOutcome,
} from "./log.js";

const HANDLE_KIND = "dataset-cursor";
const PAGE_SIZE_MAX = 50;
export const REQUIRED_SCOPE = "mcp-ref/tools.invoke";
const idempotencyKeySchema = z.string().min(8).max(128);

interface DatasetModuleOptions {
  verifier: OAuthTokenVerifier;
  requiredScopes?: string[];
}

// Deterministic synthetic dataset. Stands in for whatever a real tool
// paginates: query results, a report, a crawl frontier.
function datasetRows(dataset: string): Array<{ id: string; value: number }> {
  const seed = [...dataset].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);
  const count = 60 + (seed % 40);
  return Array.from({ length: count }, (_, i) => ({
    id: `${dataset}-${String(i + 1).padStart(4, "0")}`,
    value: (seed * (i + 1) * 2654435761) % 100000,
  }));
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(message: string) {
  return { ...text({ error: message }), isError: true as const };
}

function ownerOf(ctx: any): string {
  const subject = ctx?.http?.authInfo?.clientId;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error("caller identity missing");
  }
  return subject;
}

function requestIdOf(ctx: any): string | number {
  const requestId = ctx?.mcpReq?.id;
  return typeof requestId === "string" || typeof requestId === "number"
    ? requestId
    : "unknown";
}

interface AuditContext {
  tool: string;
  clientId: string;
  requestId: string | number;
  handleId?: string;
  operationDigest?: string;
}

interface AuditResult<T> {
  value: T;
  replayStatus: "fresh" | "replayed" | "not_applicable";
  handleId?: string;
}

function auditFailure(error: unknown): {
  outcome: ToolOutcome;
  errorCode: string;
} {
  if (error instanceof HandleStoreError) {
    return { outcome: error.code, errorCode: error.code.toUpperCase() };
  }
  return { outcome: "error", errorCode: "INTERNAL_ERROR" };
}

async function auditedTool<T>(
  context: AuditContext,
  action: () => Promise<AuditResult<T>>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await action();
    toolLog({
      ...context,
      handleId: result.handleId ?? context.handleId,
      outcome: "ok",
      replayStatus: result.replayStatus,
      durationMs: Date.now() - started,
    });
    return result.value;
  } catch (error) {
    const failure = auditFailure(error);
    toolLog({
      ...context,
      ...failure,
      replayStatus: "not_applicable",
      durationMs: Date.now() - started,
    });
    throw error;
  }
}

function knownToolError(error: unknown) {
  if (error instanceof HandleStoreError) return toolError(error.code);
  return undefined;
}

export function createDatasetModule({
  verifier,
  requiredScopes = [REQUIRED_SCOPE],
}: DatasetModuleOptions) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "dataset-reference", version: "1.0.0" });

  server.registerTool(
    "dataset_open",
    {
      description:
        "Open a read cursor over a named dataset. Returns a handle_id to pass " +
        "to dataset_next and dataset_close. Handles expire server-side.",
      inputSchema: z.object({
        dataset: z.string().min(1).max(64),
        page_size: z.number().int().min(1).max(PAGE_SIZE_MAX).default(20),
        idempotency_key: idempotencyKeySchema,
      }),
    },
    async ({ dataset, page_size, idempotency_key }, ctx) => {
      const owner = ownerOf(ctx);
      const total = datasetRows(dataset).length;
      try {
        return await auditedTool(
          {
            tool: "dataset_open",
            clientId: owner,
            requestId: requestIdOf(ctx),
            operationDigest: replayKey(
              owner,
              "dataset_open",
              idempotency_key,
            ),
          },
          async () => {
            const result = await createHandleIdempotent({
              owner,
              kind: HANDLE_KIND,
              tool: "dataset_open",
              idempotencyKey: idempotency_key,
              input: { dataset, pageSize: page_size },
              state: { dataset, pageSize: page_size, offset: 0 },
              response: (handleId, expiresAt) => ({
                handle_id: handleId,
                total_rows: total,
                expires_at: expiresAt,
              }),
            });
            return {
              value: text(result.response),
              handleId: result.response.handle_id,
              replayStatus: result.replayed ? "replayed" : "fresh",
            };
          },
        );
      } catch (error) {
        const response = knownToolError(error);
        if (response) return response;
        throw error;
      }
    },
  );

  server.registerTool(
    "dataset_next",
    {
      description: "Return the next page for an open dataset handle.",
      inputSchema: z.object({
        handle_id: z.string().min(1),
        idempotency_key: idempotencyKeySchema,
      }),
    },
    async ({ handle_id, idempotency_key }, ctx) => {
      const owner = ownerOf(ctx);
      try {
        return await auditedTool(
          {
            tool: "dataset_next",
            clientId: owner,
            requestId: requestIdOf(ctx),
            handleId: handle_id,
            operationDigest: replayKey(
              owner,
              "dataset_next",
              idempotency_key,
            ),
          },
          async () => {
            const result = await transitionHandleIdempotent({
              owner,
              handleId: handle_id,
              kind: HANDLE_KIND,
              tool: "dataset_next",
              idempotencyKey: idempotency_key,
              input: { handleId: handle_id },
              transition: (record) => {
                if (record.status === "exhausted") {
                  return {
                    state: record.state,
                    status: "exhausted",
                    response: { rows: [], done: true },
                  };
                }
                const { dataset, pageSize, offset } = record.state as {
                  dataset: string;
                  pageSize: number;
                  offset: number;
                };
                const rows = datasetRows(dataset);
                const page = rows.slice(offset, offset + pageSize);
                const nextOffset = offset + page.length;
                const done = nextOffset >= rows.length;
                return {
                  state: { dataset, pageSize, offset: nextOffset },
                  status: done ? "exhausted" : "open",
                  response: { rows: page, done },
                };
              },
            });
            return {
              value: text(result.response),
              replayStatus: result.replayed ? "replayed" : "fresh",
            };
          },
        );
      } catch (err) {
        const response = knownToolError(err);
        if (response) return response;
        throw err;
      }
    },
  );

  server.registerTool(
    "dataset_close",
    {
      description: "Close a dataset handle early. Idempotent.",
      inputSchema: z.object({ handle_id: z.string().min(1) }),
    },
    async ({ handle_id }, ctx) => {
      const owner = ownerOf(ctx);
      return auditedTool(
        {
          tool: "dataset_close",
          clientId: owner,
          requestId: requestIdOf(ctx),
          handleId: handle_id,
        },
        async () => {
          await closeHandle(owner, handle_id, HANDLE_KIND);
          return {
            value: text({ closed: true }),
            replayStatus: "not_applicable",
          };
        },
      );
    },
  );

    return server;
  });
  const authenticate = requireBearerAuth({ verifier, requiredScopes });

  return {
    async fetch(request: Request, options?: Record<string, unknown>) {
      const authInfo = await authenticate(request);
      if (authInfo instanceof Response) {
        // API Gateway is the first gate. This module gate also protects direct
        // invocation and future deployments behind a different front door.
        securityLog("module_auth_reject");
        return authInfo;
      }
      return handler.fetch(request, { ...options, authInfo });
    },
  };
}

let deployedModule: ReturnType<typeof createDatasetModule> | undefined;

function moduleFromEnv(): ReturnType<typeof createDatasetModule> {
  if (!deployedModule) {
    const requiredScope = process.env.MCP_REQUIRED_SCOPE;
    if (!requiredScope) throw new Error("MCP_REQUIRED_SCOPE is not set");
    deployedModule = createDatasetModule({
      verifier: createCognitoTokenVerifierFromEnv(),
      requiredScopes: [requiredScope],
    });
  }
  return deployedModule;
}

export default {
  fetch(request: Request, options?: Record<string, unknown>) {
    return moduleFromEnv().fetch(request, options);
  },
};
