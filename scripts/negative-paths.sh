#!/usr/bin/env bash
# Layer-3 verification against an isolated deployed stage.
#
# Two direct Lambda invocations bracket three requests that must die at the
# gateway. Once CloudWatch reports exactly the two canaries, the rejected
# requests have demonstrably consumed zero Lambda invocations.
#
# Usage:
#   ISOLATED_STAGE=negative \
#   ENDPOINT=https://<api-id>.execute-api.<region>.amazonaws.com/negative/datasets/mcp \
#   [FUNCTION_NAME=mcp-ref-negative-datasets] [REGION=eu-west-2] \
#   [ACCESS_LOG_GROUP=/aws/api-gateway/mcp-ref-negative] \
#   scripts/negative-paths.sh
#
# The function must have no invocations in the prior 15 minutes. Use a
# dedicated stage, never dev or production. The caller also needs
# lambda:InvokeFunction so the script can produce metric canaries.

set -euo pipefail

: "${ENDPOINT:?set ENDPOINT to the deployed /datasets/mcp URL}"
: "${ISOLATED_STAGE:?set ISOLATED_STAGE to a dedicated negative-path stage}"
REGION="${REGION:-eu-west-2}"
FUNCTION_NAME="${FUNCTION_NAME:-mcp-ref-${ISOLATED_STAGE}-datasets}"
ACCESS_LOG_GROUP="${ACCESS_LOG_GROUP:-/aws/api-gateway/mcp-ref-${ISOLATED_STAGE}}"

if [[ "$ISOLATED_STAGE" == "dev" || "$ISOLATED_STAGE" == "prod" || "$ISOLATED_STAGE" == "production" ]]; then
  echo "FAIL  ISOLATED_STAGE must not be a shared dev or production stage"
  exit 1
fi
if [[ "$ENDPOINT" != */"$ISOLATED_STAGE"/datasets/mcp ]]; then
  echo "FAIL  ENDPOINT does not target ISOLATED_STAGE=$ISOLATED_STAGE"
  exit 1
fi

BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/clientInfo":{"name":"negative-paths","version":"1.0.0"},"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'

# GNU date and BSD date (macOS) disagree on relative-time flags. Try both.
minutes_ago() {
  date -u -d "-$1 minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -v"-$1M" +%Y-%m-%dT%H:%M:%SZ
}

invocations_since() {
  aws cloudwatch get-metric-statistics \
    --region "$REGION" \
    --namespace AWS/Lambda \
    --metric-name Invocations \
    --dimensions Name=FunctionName,Value="$FUNCTION_NAME" \
    --start-time "$1" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --period 60 --statistics Sum \
    --query 'sum(Datapoints[].Sum)' --output text \
    | awk '{ printf "%.0f", $1 + 0 }'
}

TMP_RESPONSE=$(mktemp)
trap 'rm -f "$TMP_RESPONSE"' EXIT

invoke_canary() {
  local label="$1" status
  status=$(aws lambda invoke \
    --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --cli-binary-format raw-in-base64-out \
    --payload '{}' \
    --query StatusCode --output text \
    "$TMP_RESPONSE")
  if [[ "$status" != "200" ]]; then
    echo "FAIL  $label canary returned Lambda status $status"
    exit 1
  fi
  echo "PASS  $label Lambda metric canary accepted"
}

REQUEST_IDS=()

call() {
  # $1 label, $2 expected status, remaining args to curl
  local label="$1" want="$2"; shift 2
  local headers status reqid
  headers=$(curl -s -o /dev/null -D - -X POST "$ENDPOINT" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/list' \
    "$@" -d "$BODY")
  status=$(printf '%s' "$headers" | head -1 | awk '{print $2}')
  reqid=$(printf '%s' "$headers" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-amzn-requestid"{print $2}')
  if [[ "$status" == "$want" ]]; then
    echo "PASS  $label -> $status (reqId $reqid)"
  else
    echo "FAIL  $label -> got $status, want $want"; exit 1
  fi
  if [[ -z "$reqid" ]]; then
    echo "FAIL  $label response carried no x-amzn-requestid"
    exit 1
  fi
  REQUEST_IDS+=("$reqid")
}

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
    fi
  else
    stable_polls=0
  fi
  sleep 10
done

echo "FAIL  invocation metric did not settle at two (last value: $metric_total)"
if (( metric_total < 2 )); then
  echo "      CloudWatch did not publish both canaries before the timeout."
else
  echo "      A rejected request or unrelated caller reached the isolated function."
fi
exit 1
