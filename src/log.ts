export type ToolOutcome =
  | "ok"
  | "error"
  | "unknown_handle"
  | "idempotency_conflict"
  | "handle_contention";

export interface ToolLogEntry {
  tool: string;
  clientId: string;
  requestId: string | number;
  outcome: ToolOutcome;
  durationMs: number;
  replayStatus: "fresh" | "replayed" | "not_applicable";
  handleId?: string;
  operationDigest?: string;
  errorCode?: string;
}

export function xrayRootTraceId(
  value: string | undefined = process.env._X_AMZN_TRACE_ID,
): string {
  if (!value) return "none";
  const root = /(?:^|;)Root=([^;]+)/.exec(value)?.[1];
  return root || "none";
}

export function toolLog(entry: ToolLogEntry): void {
  console.log(
    JSON.stringify({
      msg: "tool_call",
      timestamp: new Date().toISOString(),
      traceId: xrayRootTraceId(),
      ...entry,
    }),
  );
}

// Reaching the module without a bearer token means the gateway was
// misconfigured or bypassed. That is a security signal, not noise.
export function securityLog(msg: string): void {
  console.log(
    JSON.stringify({
      msg,
      timestamp: new Date().toISOString(),
      traceId: xrayRootTraceId(),
    }),
  );
}
