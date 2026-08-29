# MCP on AWS Serverless: Reference Implementation

Deployable companion to `WHITEPAPER.md`: an MCP 2026-07-28 server on Lambda behind regional REST API Gateway, authenticated by Cognito, with owner-bound handles and TTL-scoped replay records in DynamoDB.

## Prerequisites

- Node.js 22 or newer
- Terraform 1.15.8
- Serverless Framework v4, with `serverless login` or `SERVERLESS_LICENSE_KEY`
- AWS CLI credentials for the target account and region
- `curl` and `jq` for deployed checks
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
npm run assert:template
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

The client secret is intentionally absent from SSM. Retrieve it from Cognito and exchange it with client credentials:

```bash
POOL_ID=$(aws ssm get-parameter \
  --name /mcp-ref/dev/user-pool-id \
  --query Parameter.Value --output text)
CLIENT_ID=$(aws ssm get-parameter \
  --name /mcp-ref/dev/m2m-client-id \
  --query Parameter.Value --output text)
TOKEN_URL=$(aws ssm get-parameter \
  --name /mcp-ref/dev/token-endpoint \
  --query Parameter.Value --output text)
SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --query UserPoolClient.ClientSecret --output text)
TOKEN=$(curl --silent --show-error --fail \
  --request POST "$TOKEN_URL" \
  --user "$CLIENT_ID:$SECRET" \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials&scope=mcp-ref/tools.invoke' \
  | jq -er .access_token)
export TOKEN
unset SECRET
```

Do not print the token or place it directly in shell history.

## Call a tool

`dataset_open` and `dataset_next` require an `idempotency_key` between 8 and 128 characters. Use a new opaque key for each logical operation and reuse that key only when retrying the same operation with the same arguments.

```bash
OPEN_KEY=$(openssl rand -hex 16)

curl --silent --show-error --fail "$ENDPOINT" \
  --header "Authorization: Bearer $TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --header 'MCP-Protocol-Version: 2026-07-28' \
  --header 'Mcp-Method: tools/call' \
  --header 'Mcp-Name: dataset_open' \
  --data "$(jq -cn --arg key "$OPEN_KEY" '{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "dataset_open",
      arguments: {
        dataset: "orders",
        page_size: 20,
        idempotency_key: $key
      },
      _meta: {
        "io.modelcontextprotocol/clientInfo": {
          name: "curl",
          version: "1.0.0"
        },
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  }')"
```

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

The template assertion fails unless the rendered stack contains active Lambda tracing, required gateway log variables, API-scoped Lambda invocation, and exactly `GetItem`, `DeleteItem`, and `TransactWriteItems` on the handle table. It rejects stale `PutItem`, `UpdateItem`, and wildcard grants.

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

[`WHITEPAPER.md`](WHITEPAPER.md) is the canonical standalone manuscript. It embeds its code excerpts and immutable source links directly, so it requires no publication build step or generated companion artifact.

## Layout

```text
serverless.yml                  application stack and least-privilege role
src/server.ts                   authenticated MCP tools and audit wrapper
src/handles.ts                  transactional handle and replay store
src/identity.ts                 Cognito access-token verification
src/log.ts                      structured audit events
tests/                          unit, protocol, concurrency, and gate tests
scripts/assert-template.mjs     rendered CloudFormation assertions
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