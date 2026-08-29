# MCP on AWS Serverless: Reference Implementation

Deployable companion to `WHITEPAPER.md`: an MCP 2026-07-28 server on Lambda behind regional REST API Gateway, authenticated by Cognito, with owner-bound handles and TTL-scoped replay records in DynamoDB.

## Prerequisites

- Node.js 22 or newer
- Terraform 1.15.8
- Serverless Framework v4, with `serverless login` or `SERVERLESS_LICENSE_KEY`
- AWS CLI credentials for the target account and region
- `curl`, `jq`, and OpenSSL for deployed checks
- Checkov and ShellCheck for the complete local gate

The examples default to `eu-west-2` and stage `dev`.

For local work, prefer a named AWS profile or SSO session over long-lived keys in shell history. Verify the identity before any package, plan, or deploy command:

```bash
export AWS_PROFILE=mcp-dev
export AWS_REGION=eu-west-2
aws sts get-caller-identity
```

CI uses GitHub OIDC and a read-only role for SSM-backed packaging.

## Deploy

Create the long-lived foundation first:

```bash
cd terraform/foundation
terraform init
terraform fmt -check
terraform validate
terraform plan -out=tfplan
terraform apply tfplan
cd ../..
```

Then package, inspect, and deploy the application:

```bash
npm ci
npm run verify
npm run package -- --stage dev
npx serverless deploy --stage dev
```

The deploy summary prints the MCP endpoint. Export it for later commands:

```bash
export ENDPOINT='https://<api-id>.execute-api.eu-west-2.amazonaws.com/dev/datasets/mcp'
```

WAF is optional and requires the API stage to exist. After the first application deploy:

```bash
cd terraform/foundation
terraform apply \
  -var enable_waf=true \
  -var 'api_stage_arn=arn:aws:apigateway:eu-west-2::/restapis/<api-id>/stages/dev'
```

Remote state, locking, production approvals, and deployment CI are adopter-owned. Recreating the foundation changes Cognito identifiers, so redeploy the application afterward.

## Obtain a token

The client secret is intentionally absent from SSM. Source the token helper so the resulting `TOKEN` is exported in the current shell without being printed:

```bash
source scripts/obtain-token.sh
```

Set `STAGE`, `AWS_REGION`, or `AWS_PROFILE` first to override their defaults. Run `obtain_mcp_token` again when the token expires. Do not print the token or place it directly in shell history.

## Test with MCP Playground Online

[MCP Server Tester](https://mcpplaygroundonline.com/mcp-server-tester) can discover and invoke the deployed tools from a browser. It is a third-party service, so use a disposable development stage and a fresh short-lived token. Never provide the Cognito client secret or a production token.

Prepare the endpoint and token first. On macOS, `pbcopy` transfers the token to the clipboard without printing it:

```bash
export ENDPOINT='https://<api-id>.execute-api.eu-west-2.amazonaws.com/dev/datasets/mcp'
source scripts/obtain-token.sh
printf %s "$TOKEN" | pbcopy
```

1. Open MCP Server Tester and choose HTTP or Streamable HTTP. If it offers a protocol selector, choose `2026-07-28`; this server has no legacy `initialize` handshake.
2. Paste `ENDPOINT` into the server URL field. Select Bearer authentication and paste the token value without a `Bearer ` prefix. If the UI exposes raw headers instead, set `Authorization` to `Bearer <token>`.
3. Connect and confirm that `dataset_open`, `dataset_next`, and `dataset_close` appear. After a deployment, disconnect and reconnect to refresh a cached tool schema.
4. Select `dataset_open` and invoke it with the following arguments, replacing the key with a fresh opaque value between 8 and 128 characters:

Generate a key for each new open or next-page operation with `openssl rand -hex 16`. Reuse a key only to retry the identical operation.

```json
{
  "dataset": "orders",
  "page_size": 20,
  "idempotency_key": "<fresh-key>"
}
```

The playground's generated form may serialize `page_size` as `"20"`; the server accepts either representation and normalizes it to an integer. A successful result contains a `handle_id`, `total_rows`, and `expires_at`.

Call `dataset_next` with the returned handle and a new key for each page. Reusing the same key intentionally replays the same response:

```json
{
  "handle_id": "<handle-id>",
  "idempotency_key": "<new-fresh-key>"
}
```

Repeat until the result contains `"done": true`, then call `dataset_close` with the same handle:

```json
{
  "handle_id": "<handle-id>"
}
```

An HTTP `401` usually means the token is missing or expired; source the helper again and replace the playground token. An HTTP `403` means the token lacks `mcp-ref/tools.invoke`. An `idempotency_conflict` means a key was reused with changed arguments. Input validation errors usually indicate a key outside the 8-to-128-character limit or a `page_size` outside 1 to 50. Use the raw JSON-RPC view to inspect the exact `tools/list` and `tools/call` frames.

## Call a tool

`dataset_open` and `dataset_next` require an `idempotency_key` between 8 and 128 characters. Use a new opaque key for each logical operation and reuse that key only when retrying the same operation with the same arguments.

`dataset_open.page_size` accepts an integer from 1 to 50 or its canonical decimal string form, such as `"20"`, for compatibility with form-based MCP clients. The server normalizes both forms to an integer.

```bash
npm run call:dataset-open
```

The script validates the HTTP and MCP responses, prints the decoded handle metadata, and generates a fresh idempotency key. Override its defaults with `DATASET`, `PAGE_SIZE`, or `OPEN_KEY`.

The response contains `handle_id`. Supply it to `dataset_next` with a new key, or to `dataset_close`. Retry rules are stable:

- Same owner, tool, key, and input returns the original response.
- Reusing a key with changed input returns `idempotency_conflict`.
- Concurrent distinct keys serialize through the handle version or return `handle_contention` after bounded retries.
- The final page remains replayable until the handle TTL expires.
- `dataset_close` is naturally idempotent and needs no key.

## Local and CI gates

The default verification path does not contact AWS:

```bash
npm run verify
npm run audit:dependencies
```

Artifact checks need AWS read credentials because Serverless resolves Cognito identifiers from SSM while packaging:

```bash
npm run package -- --stage dev
npm run assert:template
npm run scan
```

The template assertion fails unless the rendered stack contains active Lambda tracing, required gateway log variables, API-scoped Lambda invocation, direct `GetItem` and `DeleteItem`, and transaction-scoped `PutItem` and `UpdateItem` on the handle table. It rejects unscoped writes, unused DynamoDB actions, and wildcard resources.

Validate the foundation separately:

```bash
cd terraform/foundation
terraform fmt -check
terraform init -backend=false
terraform validate
checkov -d . --framework terraform --quiet
cd ../..
shellcheck scripts/*.sh
```

CI runs tests, type checking, production dependency audit, synthesis assertions, both Checkov scans, Terraform validation, and ShellCheck. It does not run `terraform plan`, deploy, or claim live AWS evidence.

## Deployment evidence

These checks are manual and credentialed.

### Gateway rejection

Deploy a dedicated stage and foundation, then let the negative-path script bracket three rejected requests with two Lambda metric canaries. It refuses `dev`, `prod`, and `production`, and the function must have a zero-invocation baseline for 15 minutes.

```bash
export ISOLATED_STAGE=negative
export ENDPOINT='https://<api-id>.execute-api.eu-west-2.amazonaws.com/negative/datasets/mcp'
npm run verify:negative
```

The caller needs access to CloudWatch metrics and logs plus `lambda:InvokeFunction`. Exactly two published invocations proves that the three attributed gateway `401` responses did not invoke Lambda under the isolated-stage assumption.

### Durable retries

Against an approved stage with a real Cognito access token:

```bash
export ENDPOINT='https://<api-id>.execute-api.eu-west-2.amazonaws.com/dev/datasets/mcp'
: "${TOKEN:?obtain the Cognito token first}"
npm run verify:idempotency
```

The script verifies open replay, changed-input conflict, same-key page replay, distinct-key progression, terminal replay, one complete duplicate-free traversal, and close.

### Correlation and independent audit

Gateway records contain `reqId`, `xrayTraceId`, `clientId`, `integrationStatus`, and status. Tool events contain the normalized X-Ray root as `traceId`, MCP request ID, client ID, tool, outcome, stable error code, duration, handle ID, hashed operation digest, and replay status. They omit tokens, raw idempotency keys, datasets, and rows.

Use the X-Ray root from an access record to find the matching tool event:

```text
fields @timestamp, traceId, requestId, clientId, tool, outcome,
       errorCode, replayStatus, handleId, durationMs
| filter msg = "tool_call" and traceId = "<xray-root>"
| sort @timestamp asc
```

When `enable_data_audit=true`, CloudTrail data events arrive asynchronously in `/aws/cloudtrail/mcp-ref-dev-audit`. This Logs Insights query should return no rows after replacing the role ARN fragment:

```text
fields @timestamp, userIdentity.arn, eventName
| filter eventSource = "dynamodb.amazonaws.com"
| filter userIdentity.arn not like /<execution-role-name>/
    or eventName not in ["GetItem", "DeleteItem", "TransactWriteItems"]
| stats count(*) by userIdentity.arn, eventName
```

Resolve the execution role with `aws cloudformation describe-stack-resource --stack-name mcp-ref-dev --logical-resource-id IamRoleLambdaExecution`. CloudTrail is compliance evidence with delivery latency, not a real-time alert.

## Whitepaper

[`WHITEPAPER.md`](WHITEPAPER.md) is the canonical standalone manuscript. It embeds its code excerpts and source links directly.

## Layout

```text
serverless.yml                  application stack and least-privilege role
src/server.ts                   authenticated MCP tools and audit wrapper
src/handles.ts                  transactional handle and replay store
src/identity.ts                 Cognito access-token verification
src/log.ts                      structured audit events
tests/                          unit, protocol, concurrency, and gate tests
scripts/assert-template.mjs     rendered CloudFormation assertions
scripts/dataset-open.sh         single deployed dataset_open call
scripts/obtain-token.sh         Cognito client-credentials token helper
scripts/negative-paths.sh       isolated-stage gateway rejection proof
scripts/idempotency-runtime.sh  credentialed retry proof
terraform/foundation/           Cognito, SSM, X-Ray, audit, and optional WAF
WHITEPAPER.md                   standalone reference architecture manuscript
```

## Teardown

Remove each Serverless stage first, then destroy its matching Terraform foundation:

```bash
npx serverless remove --stage dev
cd terraform/foundation
terraform destroy
```

Destroying the user pool invalidates all tokens issued by that pool.