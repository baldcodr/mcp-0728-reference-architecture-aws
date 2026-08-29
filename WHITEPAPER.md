# Deploying MCP 2026-07-28 servers on AWS: A serverless reference architecture 

**Status:** Draft, August 2026 **Companion code:** [MCP 2026-07-28 reference architecture on AWS](https://github.com/baldcodr/mcp-0728-reference-architecture-aws). See the [README](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/main/README.md) for deployment and verification commands.

## Abstract

The Model Context Protocol 2026-07-28 revision removed protocol sessions and the initialization handshake from the core transport \[1\]\[2\]. That makes the request model compatible with Lambda's lack of instance affinity, but it does not remove application state or make side effects safe to retry. This paper presents a reference architecture on AWS: API Gateway and Cognito at the primary authentication boundary, a second token verifier inside a Node.js 22 Lambda module, DynamoDB for owner-bound handles and deterministic replay, Terraform for long-lived foundation resources, and Serverless Framework v4 for the application stack. A deployment-focused STRIDE analysis connects each control to local tests, synthesized-template checks, or explicit post-deployment evidence. The result is a small working system, not a claim that managed services remove operational responsibility.

## 1\. Scope and decisions

This architecture is for one pre-registered machine client invoking remote MCP tools inside an AWS estate. It covers ingress authentication, Lambda invocation scope, durable handle state, retries, least-privilege IAM, auditability, infrastructure ownership, and pre-deployment acceptance gates. Prompt injection, tool-description poisoning, business authorization inside a tool, interactive user consent, dynamic client registration, and generalized workflow orchestration remain outside this deployment boundary.

The protocol does not require the replay ledger implemented here. Idempotency for `dataset_open` and `dataset_next` is a defense-in-depth decision for lost responses and client retries. A cursor-only implementation can conform to MCP, but a network failure after mutation can leave its caller unable to distinguish success from failure. This reference assumes that failure mode matters. Replay records expire with their handles; they are not a permanent business ledger.

## 2\. Stateless protocol, explicit state

In the 2026-07-28 core, each request carries protocol version and client capabilities; client information is normally included but optional. There is no initialization exchange, `Mcp-Session-Id`, or transport-level affinity requirement \[1\]\[2\]. Any Lambda instance can therefore process any request. Legacy `GET` and `DELETE` requests receive method errors rather than opening or terminating sessions \[1\]. Multi-step state still exists, but it is explicit: a tool returns a handle and the client supplies that handle as an ordinary argument to later calls, following SEP-2567 \[3\]. Practitioner summaries provide useful migration context but do not replace the normative specification \[5\]\[6\].

Explicit handles move continuity into a security-sensitive store, a risk also highlighted in deployment security analysis of the stateless revision \[7\]. The reference mints 128 random bits, prefixes the value with `h_`, and binds every record to the verified Cognito `client_id`, a handle kind, a status, a version, and an expiry. In the supplied deployment, that owner value is the single configured Cognito app client ID. The store remains owner-aware as defense in depth: missing, expired, mismatched-owner, malformed, and wrong-kind records produce `unknown_handle` when resolved or advanced, avoiding an existence oracle. `dataset_close` remains idempotent and returns success when no matching live handle can be deleted. DynamoDB TTL removes old records eventually, while code rejects expired records immediately because TTL deletion is asynchronous \[8\]\[9\].

The same table holds replay items. Their partition keys hash owner, tool, and caller-provided idempotency key; a second hash fingerprints canonicalized input. The raw idempotency key is stored nowhere. Reusing a key with identical input returns the recorded response. Reusing it with changed input returns `idempotency_conflict`.

[Source: src/handles.ts L127-L166](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/src/handles.ts#L127-L166)

```ts
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
```

Opening a dataset writes the handle and its response in one `TransactWriteItems` operation. If the SDK reports a timeout after DynamoDB may have committed, the code strongly rereads the replay item before deciding whether to retry. A committed request therefore returns its original handle instead of minting another one.

[Source: src/handles.ts L263-L305](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/src/handles.ts#L263-L305)

```ts
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
```

Advancing a cursor uses the same pattern with optimistic concurrency. The transaction checks owner, kind, type, live expiry, and expected version, then advances state and stores that page's response atomically. A competing idempotency key rereads the newer cursor and retries within a bound. The same key rereads the winning replay record and converges on the exact page. Exhausted handles remain until TTL so the terminal page can also be replayed.

[Source: src/handles.ts L354-L402](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/src/handles.ts#L354-L402)

```ts
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
```

## 3\. Request path and trust boundaries

The core request path is client to regional REST API Gateway, then Lambda, then one DynamoDB table. Supporting resources include a Cognito user pool and hosted domain, SSM parameters, CloudWatch log groups, X-Ray sampling, an optional CloudTrail data-event trail with S3 delivery, and an optional WAF association.

![MCP reference architecture on AWS, showing deployment ownership, the authenticated request path, durable state, and audit evidence]()

**Figure 1\. MCP 2026-07-28 reference architecture on AWS.** Blue arrows and arrow cells show the client, runtime, and data path. The orange, blue, and green bands separate the Terraform foundation, Serverless application, and evidence surfaces; dashed card borders mark optional resources. A [PNG fallback](http://docs/architecture/mcp-aws-reference-architecture.png) and the [editable D2 source](http://docs/architecture/mcp-aws-reference-architecture.d2) are included with this paper.

The numbered nodes identify the three authorization checks that protect state: the gateway authorizer rejects invalid access tokens before invocation, the Lambda module verifies the token again, and every table operation binds the record to the resulting `client_id`. The ownership bands also distinguish the long-lived Terraform foundation from the per-stage Serverless application; their only deployment contract is the four non-secret identifiers published through SSM.

API Gateway's Cognito authorizer is the primary gate. It checks the access token and required `mcp-ref/tools.invoke` scope before Lambda invocation, so rejected edge traffic consumes no function invocation \[4\]. Serverless Framework v4's `mcp` block declares the route, streaming integration, timeout, authorizer, and handler bridge; the companion v4 MCP example provides a second implementation reference \[4\]\[11\]. The rendered Lambda permission is scoped to the synthesized REST API. It is not asserted to be route-exclusive, because the framework-generated source ARN may admit methods and paths within that API.

[Source: serverless.yml L75-L88](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/serverless.yml#L75-L88)

```
      authorizer:
        # Cognito user pool authorizer: API Gateway validates the JWT
        # itself. Rejection costs zero invocations. With scopes set,
        # callers present a Cognito access token carrying the scope.
        name: mcpUserPool
        arn: ${ssm:/mcp-ref/${sls:stage}/user-pool-arn}
        scopes:
          - mcp-ref/tools.invoke
      environment:
        HANDLES_TABLE: !Ref HandlesTable
        HANDLE_TTL_SECONDS: '900'
        COGNITO_USER_POOL_ID: ${ssm:/mcp-ref/${sls:stage}/user-pool-id}
        COGNITO_CLIENT_ID: ${ssm:/mcp-ref/${sls:stage}/m2m-client-id}
        MCP_REQUIRED_SCOPE: mcp-ref/tools.invoke
```

The Lambda module does not merely decode claims. `aws-jwt-verify` checks the expected user pool, token use `access`, exact app client, signature, and expiry. The SDK's bearer gate then enforces the required scope and maps verified `client_id` to `authInfo.clientId`. Terraform provisions one Cognito M2M app client, publishes its ID through one SSM parameter, and the module verifier accepts only that exact ID. The supplied stack therefore demonstrates one machine principal, not isolation between multiple deployed machine clients. This second gate is a backstop for direct invocation, future front-door changes, and configuration mistakes. It does not replace the gateway: a request rejected here has already consumed an invocation.

[Source: src/identity.ts L18-L46](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/src/identity.ts#L18-L46)

```ts

export interface CognitoAccessTokenVerifier {
  verify(token: string): Promise<CognitoAccessTokenClaims>;
}

function defaultCognitoVerifier(
  config: CognitoVerifierConfig,
): CognitoAccessTokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: "access",
    clientId: config.clientId,
    includeRawJwtInErrors: false,
  });
  return { verify: (token) => verifier.verify(token) };
}

export function createCognitoTokenVerifier(
  config: CognitoVerifierConfig,
  cognitoVerifier = defaultCognitoVerifier(config),
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      try {
        const claims = await cognitoVerifier.verify(token);
        if (
          claims.client_id !== config.clientId ||
          typeof claims.scope !== "string" ||
          typeof claims.exp !== "number"
```

[Source: src/server.ts L302-L315](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/src/server.ts#L302-L315)

```ts
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
```

The regional endpoint choice raises the response-stream idle allowance compared with the edge-optimized default described by Serverless \[4\]. The 60-second Lambda timeout is also a cost bound because a disconnected client does not necessarily stop running work. Progress notifications can keep a synchronous response active; genuinely asynchronous or longer workflows belong on the Tasks extension rather than behind a larger Lambda timeout \[2\]\[4\].

## 4\. Infrastructure ownership and least privilege

Terraform owns the long-lived foundation: Cognito resources, four non-secret SSM contract parameters, X-Ray sampling, optional CloudTrail delivery resources, and optional WAF. Serverless owns the per-stage application: MCP function and route, authorizer attachment, handle table, logs, tracing, and execution role. The split keeps user-pool destruction out of an application teardown while allowing the service team to package and replace its runtime independently.

The stacks exchange identifiers through SSM instead of importing one another's state. Serverless can consume Terraform outputs directly \[10\], but the parameter contract is easier to preserve if either tool changes. State is independent, not deployment: recreating Cognito changes those values and requires the application to be packaged and deployed again. The example intentionally leaves remote Terraform state, locking, approval policy, and production CI deployment to the adopter.

[Source: terraform/foundation/main.tf L74-L99](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/terraform/foundation/main.tf#L74-L99)

```
resource "aws_ssm_parameter" "user_pool_arn" {
  # checkov:skip=CKV2_AWS_34:Non-secret identifier, published deliberately as the contract between the two stacks. The client secret is never written to SSM.
  name  = "/${var.name_prefix}/${var.stage}/user-pool-arn"
  type  = "String"
  value = aws_cognito_user_pool.mcp.arn
}

resource "aws_ssm_parameter" "user_pool_id" {
  # checkov:skip=CKV2_AWS_34:Non-secret identifier, published deliberately as the contract between the two stacks. The client secret is never written to SSM.
  name  = "/${var.name_prefix}/${var.stage}/user-pool-id"
  type  = "String"
  value = aws_cognito_user_pool.mcp.id
}

resource "aws_ssm_parameter" "m2m_client_id" {
  # checkov:skip=CKV2_AWS_34:Non-secret identifier, published deliberately as the contract between the two stacks. The client secret is never written to SSM.
  name  = "/${var.name_prefix}/${var.stage}/m2m-client-id"
  type  = "String"
  value = aws_cognito_user_pool_client.m2m.id
}

resource "aws_ssm_parameter" "token_endpoint" {
  # checkov:skip=CKV2_AWS_34:Non-secret identifier, published deliberately as the contract between the two stacks. The client secret is never written to SSM.
  name  = "/${var.name_prefix}/${var.stage}/token-endpoint"
  type  = "String"
  value = "https://${aws_cognito_user_pool_domain.mcp.domain}.auth.${var.aws_region}.amazoncognito.com/oauth2/token"
```

The hardened store reads with `GetItem`, closes with `DeleteItem`, and writes through `TransactWriteItems`, all against the handle table ARN. DynamoDB authorizes each transaction suboperation through its underlying IAM action, so the role grants `PutItem` and `UpdateItem` only when `dynamodb:EnclosingOperation` is `TransactWriteItems` \[25\]. It needs neither `Query` nor `Scan`, and cannot issue `PutItem` or `UpdateItem` directly. Active X-Ray tracing adds AWS's required trace-write permissions, which do not support resource-level scoping.

[Source: serverless.yml L48-L69](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/main/serverless.yml#L48-L69)

```
  iam:
    role:
      statements:
        - Effect: Allow
          Action:
            - dynamodb:GetItem
            - dynamodb:DeleteItem
          Resource: !GetAtt HandlesTable.Arn
        - Effect: Allow
          Action:
            - dynamodb:PutItem
            - dynamodb:UpdateItem
          Resource: !GetAtt HandlesTable.Arn
          Condition:
            ForAnyValue:StringEquals:
              dynamodb:EnclosingOperation:
                - TransactWriteItems
```

## 5\. Threat model (STRIDE)

| Threat | Surface | Control and evidence |
| :---- | :---- | :---- |
| **Spoofing** | Missing or forged tokens; mismatched-owner handles; alternate ingress | Cognito rejects at the edge; module verification  admits only the configured app client; handle ownership uses its verified `client_id`; 128-bit handle values resist guessing. Local tests exercise mismatched owner values as defense in depth, not as evidence of a multi-client deployment. |
| **Tampering** | Cursor and replay records; deployment artifacts | Conditional transactions bind type, owner, kind, version, and expiry; CI tests rendered permissions and scans synthesized CloudFormation. Terraform configuration is validated and scanned, while apply review is adopter-owned. |
| **Repudiation** | A client disputes a tool attempt | Gateway logs retain request ID and X-Ray root. Exactly one  structured tool event records timestamp, root trace ID, MCP request ID, client ID, outcome, stable error code, duration, handle ID, operation digest, and replay status. Optional CloudTrail data events independently record table APIs. |
| **Information disclosure** | Tokens, arguments, rows, and identifiers in logs | Tool events omit tokens, raw idempotency keys, datasets, rows, and exception messages. Routing headers contain only method and tool names. Table encryption protects stored state at rest, while point-in-time recovery supports recovery from accidental mutation.  |
| **Denial of service** | Invalid traffic, long calls, table contention, spend | Gateway authentication rejects bad tokens before Lambda; optional WAF limits source-IP rates; function timeout caps a single execution; bounded transaction retries fail as `handle_contention`. On-demand DynamoDB reduces capacity planning but does not remove quotas or cost exposure. |
| **Elevation of privilege** | Every action on the execution role is reachable by tool code | DynamoDB data access is three named operations on one table; no wildcard data resource, table scan, outbound function invocation, or broad AWS service access is granted. |

Audit records use the X-Ray root as the cross-service join key. API Gateway request ID remains the edge attribution key, while the MCP JSON-RPC request ID identifies the logical call. API Gateway exposes those values through documented access-log variables \[13\]. The operation digest permits same-key replay analysis without recording the raw key. Optional fields can extend the schema when future claims require them.

[Source: src/log.ts L1-L37](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/src/log.ts#L1-L37)

```ts
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
```

CloudTrail is independent of the function but optional, asynchronous, and not a real-time detector \[12\]. Its trail selects DynamoDB data events for the named table and delivers to CloudWatch Logs and versioned S3. Operators should query for principals other than the execution role or event names outside `GetItem`, `DeleteItem`, and `TransactWriteItems`, allowing for delivery latency.

## 6\. Acceptance gates and runtime evidence

Layer 1 runs without AWS. Vitest sends complete 2026-07-28 requests through the module's web-standard `fetch` contract and mocks DynamoDB at the command boundary. Tests cover token rejection, owner-mismatch rejection, opaque handle failures, key reuse conflicts, ambiguous commit recovery, bounded contention, terminal replay, and a deliberately interleaved pair where two calls read version zero but only one transaction advances it. The owner-mismatch cases exercise the generic storage boundary with synthetic owner values; they do not establish isolation between multiple principals provisioned by this deployment. The audit test also proves one event per attempt and absence of argument values.

Layer 2 inspects deployment artifacts. `serverless package` resolves SSM and synthesizes CloudFormation without creating resources. The assertion script requires active function tracing, gateway access-log variables, exact DynamoDB actions and table scope, and an API Gateway Lambda permission tied to the rendered REST API. Checkov scans that output; Terraform formatting, initialization without a backend, validation, and Checkov cover the foundation. These are CI gates. A reviewed `terraform plan` is an operator gate because this repository does not prescribe credentials, remote state, or approval workflow.

[Source: scripts/assert-template.mjs L133-L159](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/scripts/assert-template.mjs#L133-L159)

```javascript
const restApiIds = Object.entries(resourceMap)
  .filter(([, resource]) => resource.Type === "AWS::ApiGateway::RestApi")
  .map(([logicalId]) => logicalId);
const apiGatewayPermissions = resources.filter(
  (resource) =>
    resource.Type === "AWS::Lambda::Permission" &&
    resource.Properties?.Action === "lambda:InvokeFunction" &&
    resource.Properties?.Principal === "apigateway.amazonaws.com",
);
for (const [functionId] of Object.entries(resourceMap).filter(
  ([, resource]) => resource.Type === "AWS::Lambda::Function",
)) {
  const permission = apiGatewayPermissions.find((candidate) =>
    referencesLogicalId(candidate.Properties?.FunctionName, functionId),
  );
  if (!permission) {
    fail(`${functionId} has no API Gateway invoke permission`);
    continue;
  }
  if (
    !restApiIds.some((apiId) =>
      referencesLogicalId(permission.Properties?.SourceArn, apiId),
    )
  ) {
    fail(`${functionId} invoke permission is not scoped to the rendered REST API`);
  }
}
```

Layer 3 is manual after an approved deployment. `scripts/negative-paths.sh` refuses shared `dev` and production stages, requires a zero baseline on an isolated function, brackets three rejected requests with two direct Lambda canaries, attributes every `401` by gateway request ID, and waits for the metric to settle at exactly two invocations. That establishes zero Lambda consumption for those requests under the script's isolation assumption, rather than generalizing from an arbitrary quiet window.

[Source: scripts/negative-paths.sh L100-L149](https://github.com/baldcodr/mcp-0728-reference-architecture-aws/blob/a708458028e7fdf52a92b2b86b81fdb53c4a88f0/scripts/negative-paths.sh#L100-L149)

```shell
METRIC_START=$(minutes_ago 15)
BASELINE=$(invocations_since "$METRIC_START")
if (( BASELINE != 0 )); then
  echo "FAIL  $FUNCTION_NAME has $BASELINE invocation(s) in the prior 15 minutes"
  echo "      Use a fresh or idle isolated stage so the result is attributable."
  exit 1
fi
echo "PASS  isolated function has a zero-invocation baseline"

invoke_canary "opening"

call "no token"          401
call "malformed token"   401 -H 'Authorization: Bearer not-a-jwt'
call "unsigned token"    401 -H "Authorization: Bearer $(printf '%s' '{"alg":"none"}' | base64).$(printf '%s' '{"sub":"forged"}' | base64)."

for reqid in "${REQUEST_IDS[@]}"; do
  echo "Looking for rejected reqId $reqid in access logs..."
  found=""
  for ((attempt = 1; attempt <= 18; attempt += 1)); do
    found=$(aws logs filter-log-events --region "$REGION" \
      --log-group-name "$ACCESS_LOG_GROUP" \
      --start-time $(( ($(date +%s) - 600) * 1000 )) \
      --filter-pattern "\"$reqid\"" \
      --query 'events[0].message' --output text 2>/dev/null || true)
    [[ -n "$found" && "$found" != "None" ]] && break
    sleep 5
  done
  if [[ "$found" != *'"status":"401"'* || ( "$found" != *'"integrationStatus":""'* && "$found" != *'"integrationStatus":"-"'* ) ]]; then
    echo "FAIL  request $reqid was not found as a pre-integration 401 in $ACCESS_LOG_GROUP"
    exit 1
  fi
  echo "PASS  rejected request $reqid is attributed before integration"
done

invoke_canary "closing"

stable_polls=0
metric_total=0
echo "Waiting for both canaries to settle in the Invocations metric..."
for ((attempt = 1; attempt <= 30; attempt += 1)); do
  metric_total=$(invocations_since "$METRIC_START")
  if (( metric_total > 2 )); then
    echo "FAIL  observed $metric_total invocations; expected only the two canaries"
    exit 1
  fi
  if (( metric_total == 2 )); then
    stable_polls=$((stable_polls + 1))
    if (( stable_polls == 6 )); then
      echo "PASS  exactly two canary invocations observed; all gateway rejections consumed zero"
      exit 0
```

With a real client-credentials token, `scripts/idempotency-runtime.sh` verifies open replay, changed-input conflict, same-key page replay, distinct-key progression, terminal replay, duplicate-free traversal, and close. Operators then correlate a successful request by the same X-Ray root in the gateway access record, Lambda tool event, and trace. These checks require adopter credentials and incur AWS activity, so they are deployment acceptance evidence, not pull-request CI.

## 7\. Limits and adoption choices

Cognito has no dynamic client registration in this design; the caller is one provisioned M2M app client. OAuth discovery, interactive authorization, and deprecated protocol features such as dynamic client registration and Sampling are not implemented here \[1\]\[4\]. Resource subscriptions cannot rely on one Lambda instance's in-memory listeners. Multi-region cursor concurrency, payloads near DynamoDB's item limit, long-retention replay, and workflow engines need different storage or orchestration.

The optional WAF association is a second Terraform apply because the API stage ARN does not exist before the Serverless deployment. CloudTrail retention, KMS customer-managed keys, alarm routing, X-Ray sampling rate, state backend, backup policy, organizational trails, and production deployment approvals are deliberately adopter choices. This reference supplies a checkable baseline, not a universal operating model.

### 7.1 AgentCore Gateway alternative

Amazon Bedrock AgentCore Gateway is an alternative front door, not an implementation included in this repository. With a native Lambda target, it can replace the API Gateway authorizer and application-owned MCP transport with managed per-request version selection, target aggregation, tool discovery, target translation, and inbound and outbound authorization \[14\]\[22\]\[23\]. Optional AgentCore Policy and customer-defined rate limits add centralized controls over tools, inputs, and caller traffic; the rate-limit service fails open by default and therefore is not a sole security boundary \[16\]\[17\]. Gateway publishes CloudWatch invocation, error, latency, duration, and target-execution metrics, while vended logs and OpenTelemetry spans require additional configuration \[18\]. Those logs can include complete MCP request and response bodies, so this paper's audit property would still require deliberate field review and the application-owned tool event.

This option is strongest when several tool providers must appear behind one governed MCP endpoint or clients must migrate between supported MCP versions independently. Its costs are an additional managed data plane, AgentCore-specific target event and naming contracts, separately metered gateway, search, policy, and observability operations \[24\], and greater AWS coupling. A native Lambda target also needs an adapter because AgentCore passes validated tool arguments rather than the raw request consumed by the current MCP handler \[19\]. Durable handles, immediate expiry checks, optimistic concurrency, deterministic replay, and business-level audit events remain application concerns; managed protocol translation does not make side effects idempotent.

Identity is the decisive migration constraint for this implementation. AgentCore can validate the inbound Cognito JWT and restrict allowed client IDs and scopes, but the documented native Lambda context contains message, request, gateway, target, and tool metadata, not the token's Cognito client\_id \[15\]\[19\]. The current owner invariant can therefore be preserved with a native target only if one gateway admits exactly one app client, Lambda maps that verified gateway ID to the configured client ID, direct invocation is restricted, and deployed tests prove the mapping. Supporting multiple clients would require a different design. Options include a separate gateway per client, or a shared gateway that preserves caller identity downstream, such as an MCP server target using AgentCore on-behalf-of token exchange with an authorization server that supports RFC 8693 \[20\]. The current Cognito token endpoint supports authorization\_code, refresh\_token, and client\_credentials grants, not RFC 8693 token exchange \[21\]. This alternative warrants a separate implementation and acceptance study before it can replace the evidence-backed request path presented here.

## 8\. References

1. Model Context Protocol, "Specification 2026-07-28." [https://modelcontextprotocol.io/specification/2026-07-28/](https://modelcontextprotocol.io/specification/2026-07-28/)  
2. Model Context Protocol maintainers, "The 2026-07-28 Specification," 28 Jul 2026\. [https://blog.modelcontextprotocol.io/posts/2026-07-28/](https://blog.modelcontextprotocol.io/posts/2026-07-28/)  
3. Model Context Protocol, "SEP-2567: Sessionless MCP via Explicit State Handles." [https://modelcontextprotocol.io/seps/2567-sessionless-mcp](https://modelcontextprotocol.io/seps/2567-sessionless-mcp)   
4. Serverless Inc., "MCP Servers," Serverless Framework documentation. [https://www.serverless.com/framework/docs/providers/aws/guide/mcp](https://www.serverless.com/framework/docs/providers/aws/guide/mcp)  
5. Nango, "Stateless MCP: how it changes the way agents call tools," Aug 2026\. [https://nango.dev/blog/stateless-mcp-how-it-changes-the-way-agents-call-tools/](https://nango.dev/blog/stateless-mcp-how-it-changes-the-way-agents-call-tools/)  
6. Appwrite, "What's new in the MCP 2026-07-28 specification," Aug 2026\. [https://appwrite.io/blog/post/mcp-goes-stateless-in-the-2026-07-28-specification](https://appwrite.io/blog/post/mcp-goes-stateless-in-the-2026-07-28-specification)  
7. Equixly, "Stateless MCP: What the 2026-07-28 specification changes for security," 5 Aug 2026\. [https://equixly.com/blog/2026/08/05/stateless-mcp/](https://equixly.com/blog/2026/08/05/stateless-mcp/)  
8. AWS, "Using time to live (TTL) in DynamoDB." [https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)  
9. AWS, "Working with expired items and time to live (TTL)." [https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ttl-expired-items.html](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ttl-expired-items.html)  
10. Serverless Inc., "Terraform State Output variables," Serverless Framework documentation. [https://www.serverless.com/framework/docs/guides/variables/hashicorp/terraform](https://www.serverless.com/framework/docs/guides/variables/hashicorp/terraform)  
11. Serverless Inc., "MCP examples," Serverless Examples repository, v4 branch. [https://github.com/serverless/examples/tree/v4/mcp](https://github.com/serverless/examples/tree/v4/mcp)  
12. AWS, "Logging data events," AWS CloudTrail User Guide. [https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html)  
13. AWS, "Variables for access logging," Amazon API Gateway Developer Guide. [https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html)  
14. AWS, "How AgentCore Gateway supports the MCP 2026-07-28 spec," 28 Jul 2026\. [https://aws.amazon.com/blogs/machine-learning/how-agentcore-gateway-supports-the-mcp-2026-07-28-spec/](https://aws.amazon.com/blogs/machine-learning/how-agentcore-gateway-supports-the-mcp-2026-07-28-spec/)   
15. AWS, "Set up inbound authorization for your gateway," Amazon Bedrock AgentCore Developer Guide. [https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html)   
16. AWS, "Policy in Amazon Bedrock AgentCore." [https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html)   
17. AWS, "Add rate limits to a gateway," Amazon Bedrock AgentCore Developer Guide. [https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-rate-limits.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-rate-limits.html)   
18. AWS, "AgentCore generated gateway observability data." [https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-gateway-metrics.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-gateway-metrics.html)   
19. AWS, "AWS Lambda function targets," Amazon Bedrock AgentCore Developer Guide. [https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html)   
20. AWS, "On-behalf-of token exchange with AgentCore Identity." [https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html)   
21. AWS, "The token issuer endpoint," Amazon Cognito Developer Guide. https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html  
22. AWS, "Amazon Bedrock AgentCore Gateway: A secure AI gateway for agents, tools, and models." [https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html)   
23. AWS, "Set up outbound authorization for your gateway," Amazon Bedrock AgentCore Developer Guide. [https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-outbound-auth.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-outbound-auth.html)   
24. AWS, "Amazon Bedrock AgentCore pricing." [https://aws.amazon.com/bedrock/agentcore/pricing/](https://aws.amazon.com/bedrock/agentcore/pricing/) 
25. AWS, "Using IAM with DynamoDB transactions," Amazon DynamoDB Developer Guide. [https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)

