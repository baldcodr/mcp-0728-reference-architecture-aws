#!/usr/bin/env bash
# Invoke dataset_open against a deployed MCP endpoint.
#
# Usage:
#   ENDPOINT=https://<api-id>.execute-api.<region>.amazonaws.com/dev/datasets/mcp \
#   TOKEN=<cognito-access-token> scripts/dataset-open.sh
#
# Optional: DATASET=orders PAGE_SIZE=20 OPEN_KEY=<8-to-128-character-key>

set -euo pipefail

: "${ENDPOINT:?set ENDPOINT to the deployed /datasets/mcp URL}"
: "${TOKEN:?set TOKEN to a Cognito access token with mcp-ref/tools.invoke}"

DATASET="${DATASET:-orders}"
PAGE_SIZE="${PAGE_SIZE:-20}"

for command in curl jq openssl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "FAIL  required command is missing: $command" >&2
    exit 1
  fi
done

if [[ "$ENDPOINT" != https://* ]]; then
  echo "FAIL  ENDPOINT must use HTTPS" >&2
  exit 1
fi
if [[ -z "$DATASET" || ${#DATASET} -gt 64 ]]; then
  echo "FAIL  DATASET must contain between 1 and 64 characters" >&2
  exit 1
fi
if [[ ! "$PAGE_SIZE" =~ ^[0-9]+$ ]] || (( PAGE_SIZE < 1 || PAGE_SIZE > 50 )); then
  echo "FAIL  PAGE_SIZE must be an integer between 1 and 50" >&2
  exit 1
fi

OPEN_KEY="${OPEN_KEY:-$(openssl rand -hex 16)}"
if (( ${#OPEN_KEY} < 8 || ${#OPEN_KEY} > 128 )); then
  echo "FAIL  OPEN_KEY must contain between 8 and 128 characters" >&2
  exit 1
fi

REQUEST_ID="dataset-open-$(date -u +%Y%m%dT%H%M%SZ)-$$"
PAYLOAD=$(jq -cn \
  --arg id "$REQUEST_ID" \
  --arg dataset "$DATASET" \
  --arg key "$OPEN_KEY" \
  --argjson pageSize "$PAGE_SIZE" \
  '{
    jsonrpc: "2.0",
    id: $id,
    method: "tools/call",
    params: {
      name: "dataset_open",
      arguments: {
        dataset: $dataset,
        page_size: $pageSize,
        idempotency_key: $key
      },
      _meta: {
        "io.modelcontextprotocol/clientInfo": {
          name: "dataset-open-script",
          version: "1.0.0"
        },
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  }')

response_file=$(mktemp)
headers_file=$(mktemp)
trap 'rm -f "$response_file" "$headers_file"' EXIT

set +e
http_status=$(curl --silent --show-error \
  --request POST "$ENDPOINT" \
  --header "Authorization: Bearer $TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --header 'MCP-Protocol-Version: 2026-07-28' \
  --header 'Mcp-Method: tools/call' \
  --header 'Mcp-Name: dataset_open' \
  --data-binary "$PAYLOAD" \
  --dump-header "$headers_file" \
  --output "$response_file" \
  --write-out '%{http_code}')
curl_status=$?
set -e

if (( curl_status != 0 )); then
  echo "FAIL  curl transport error (exit $curl_status)" >&2
  exit "$curl_status"
fi

gateway_request_id=$(awk -F': *' '
  tolower($1) == "x-amzn-requestid" {
    gsub("\r", "", $2)
    value = $2
  }
  END { print value }
' "$headers_file")

if [[ ! "$http_status" =~ ^2[0-9][0-9]$ ]]; then
  echo "FAIL  endpoint returned HTTP $http_status${gateway_request_id:+ (request $gateway_request_id)}" >&2
  if jq -e . "$response_file" >/dev/null 2>&1; then
    jq . "$response_file" >&2
  else
    cat "$response_file" >&2
  fi
  exit 1
fi

if ! jq -e --arg id "$REQUEST_ID" '
    .jsonrpc == "2.0" and
    .id == $id and
    .error == null and
    (.result.content | type) == "array" and
    (.result.content[0].type == "text") and
    ((.result.content[0].text | type) == "string")
  ' "$response_file" >/dev/null; then
  echo "FAIL  endpoint returned an invalid MCP response" >&2
  jq . "$response_file" >&2 || cat "$response_file" >&2
  exit 1
fi

if [[ "$(jq -r '.result.isError // false' "$response_file")" == "true" ]]; then
  echo "FAIL  dataset_open returned a tool error" >&2
  jq -r '.result.content[0].text' "$response_file" >&2
  exit 1
fi

if ! tool_result=$(jq -er '.result.content[0].text | fromjson' "$response_file"); then
  echo "FAIL  dataset_open result text is not JSON" >&2
  exit 1
fi

if ! jq -e '
    ((.handle_id | type) == "string") and
    (.handle_id | startswith("h_")) and
    ((.total_rows | type) == "number") and
    ((.expires_at | type) == "number")
  ' <<<"$tool_result" >/dev/null; then
  echo "FAIL  dataset_open result is missing handle metadata" >&2
  jq . <<<"$tool_result" >&2
  exit 1
fi

echo "PASS  dataset_open succeeded${gateway_request_id:+ (request $gateway_request_id)}" >&2
echo "      reuse OPEN_KEY=$OPEN_KEY only to retry this same operation" >&2
jq -S . <<<"$tool_result"