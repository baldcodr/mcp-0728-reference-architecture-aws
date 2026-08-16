#!/usr/bin/env bash
# Credentialed runtime proof for durable MCP retries.
#
# Usage:
#   ENDPOINT=https://<api-id>.execute-api.<region>.amazonaws.com/dev/datasets/mcp \
#   TOKEN=<cognito-access-token> scripts/idempotency-runtime.sh

set -euo pipefail

: "${ENDPOINT:?set ENDPOINT to the deployed /datasets/mcp URL}"
: "${TOKEN:?set TOKEN to a Cognito access token with mcp-ref/tools.invoke}"

for command in curl jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "FAIL  required command is missing: $command"
    exit 1
  fi
done

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
DATASET="runtime-${RUN_ID}"
OPEN_KEY="open-${RUN_ID}"
FIRST_PAGE_KEY="next-a-${RUN_ID}"
FINAL_PAGE_KEY="next-b-${RUN_ID}"

tool_call() {
  local tool="$1" arguments="$2" request_id payload response parsed
  request_id="${RUN_ID}-${tool}-${RANDOM}"
  payload=$(jq -cn \
    --arg id "$request_id" \
    --arg tool "$tool" \
    --argjson arguments "$arguments" \
    '{
      jsonrpc: "2.0",
      id: $id,
      method: "tools/call",
      params: {
        name: $tool,
        arguments: $arguments,
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "idempotency-runtime",
            version: "1.0.0"
          },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    }')

  response=$(curl --silent --show-error --fail \
    --request POST "$ENDPOINT" \
    --header "Authorization: Bearer $TOKEN" \
    --header 'Content-Type: application/json' \
    --header 'Accept: application/json' \
    --header 'MCP-Protocol-Version: 2026-07-28' \
    --header 'Mcp-Method: tools/call' \
    --header "Mcp-Name: $tool" \
    --data "$payload")

  if ! parsed=$(jq -cer '
      if .error != null then error(.error.message // "JSON-RPC error")
      elif .result.content[0].text == null then error("missing tool result")
      else (.result.content[0].text | fromjson)
      end
    ' <<<"$response"); then
    echo "FAIL  $tool returned an invalid MCP response" >&2
    jq -c '{jsonrpc, id, error, result: {isError: .result.isError}}' \
      <<<"$response" >&2 || true
    return 1
  fi
  jq -cS . <<<"$parsed"
}

assert_json() {
  local label="$1" value="$2" expression="$3"
  if jq -en --argjson value "$value" "$expression" >/dev/null; then
    echo "PASS  $label" >&2
  else
    echo "FAIL  $label" >&2
    return 1
  fi
}

open_arguments=$(jq -cn \
  --arg dataset "$DATASET" \
  --arg key "$OPEN_KEY" \
  '{dataset: $dataset, page_size: 50, idempotency_key: $key}')
open_first=$(tool_call dataset_open "$open_arguments")
open_replay=$(tool_call dataset_open "$open_arguments")
if [[ "$open_first" != "$open_replay" ]]; then
  echo "FAIL  repeated dataset_open did not return the original result"
  exit 1
fi
assert_json "dataset_open replays one handle" "$open_first" \
  '$value.handle_id | type == "string" and startswith("h_")'

conflict_arguments=$(jq -cn \
  --arg dataset "${DATASET}-changed" \
  --arg key "$OPEN_KEY" \
  '{dataset: $dataset, page_size: 50, idempotency_key: $key}')
open_conflict=$(tool_call dataset_open "$conflict_arguments")
assert_json "changed input produces idempotency_conflict" "$open_conflict" \
  '$value.error == "idempotency_conflict"'

handle_id=$(jq -er '.handle_id' <<<"$open_first")
total_rows=$(jq -er '.total_rows' <<<"$open_first")
first_page_arguments=$(jq -cn \
  --arg handle "$handle_id" \
  --arg key "$FIRST_PAGE_KEY" \
  '{handle_id: $handle, idempotency_key: $key}')
first_page=$(tool_call dataset_next "$first_page_arguments")
first_page_replay=$(tool_call dataset_next "$first_page_arguments")
if [[ "$first_page" != "$first_page_replay" ]]; then
  echo "FAIL  repeated first-page request did not replay the original page"
  exit 1
fi
assert_json "same-key dataset_next replays the first page" "$first_page" \
  '$value.done == false and ($value.rows | length) == 50'

final_page_arguments=$(jq -cn \
  --arg handle "$handle_id" \
  --arg key "$FINAL_PAGE_KEY" \
  '{handle_id: $handle, idempotency_key: $key}')
final_page=$(tool_call dataset_next "$final_page_arguments")
final_page_replay=$(tool_call dataset_next "$final_page_arguments")
if [[ "$final_page" != "$final_page_replay" ]]; then
  echo "FAIL  repeated terminal request did not replay the original page"
  exit 1
fi
assert_json "a distinct key advances to and replays the terminal page" "$final_page" \
  '$value.done == true and ($value.rows | length) > 0'

if ! jq -en \
  --argjson first "$first_page" \
  --argjson final "$final_page" \
  --argjson total "$total_rows" \
  '([$first.rows[].id, $final.rows[].id] | length) == $total
   and ([$first.rows[].id, $final.rows[].id] | unique | length) == $total' \
  >/dev/null; then
  echo "FAIL  distinct keys did not produce one complete, duplicate-free traversal"
  exit 1
fi
echo "PASS  distinct keys produce one complete, duplicate-free traversal"

close_arguments=$(jq -cn --arg handle "$handle_id" '{handle_id: $handle}')
closed=$(tool_call dataset_close "$close_arguments")
assert_json "dataset_close succeeds" "$closed" '$value.closed == true'

echo "PASS  deployed idempotency contract verified for handle $handle_id"