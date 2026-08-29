#!/usr/bin/env bash
# Obtain a Cognito client-credentials token without printing the token or secret.
#
# Usage:
#   source scripts/obtain-token.sh
#
# Optional: STAGE=dev AWS_REGION=eu-west-2 AWS_PROFILE=mcp-dev

if [[ -n "${BASH_VERSION:-}" && "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "FAIL  source this script so TOKEN remains in the current shell:" >&2
  echo "      source scripts/obtain-token.sh" >&2
  exit 1
fi

obtain_mcp_token() {
  local stage="${STAGE:-dev}"
  local region="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-2}}"
  local scope="${MCP_SCOPE:-mcp-ref/tools.invoke}"
  local parameter_prefix="${SSM_PREFIX:-/mcp-ref/${stage}}"
  local pool_id=""
  local client_id=""
  local token_url=""
  local client_secret=""
  local token_response=""
  local token=""
  local expires_in=""
  local curl_user=""
  local succeeded=false
  local restore_xtrace=false

  if [[ $- == *x* ]]; then
    restore_xtrace=true
    set +x
  fi

  while true; do
    for required_command in aws curl jq; do
      if ! command -v "$required_command" >/dev/null 2>&1; then
        echo "FAIL  required command is missing: $required_command" >&2
        break 2
      fi
    done

    if [[ ! "$stage" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "FAIL  STAGE may contain only letters, numbers, underscores, and hyphens" >&2
      break
    fi

    if ! AWS_PAGER="" aws sts get-caller-identity \
      --region "$region" --output json >/dev/null; then
      echo "FAIL  AWS credentials are unavailable or expired" >&2
      break
    fi

    if ! pool_id=$(AWS_PAGER="" aws ssm get-parameter \
      --region "$region" \
      --name "$parameter_prefix/user-pool-id" \
      --query Parameter.Value --output text); then
      echo "FAIL  could not read the Cognito user pool ID from SSM" >&2
      break
    fi
    if ! client_id=$(AWS_PAGER="" aws ssm get-parameter \
      --region "$region" \
      --name "$parameter_prefix/m2m-client-id" \
      --query Parameter.Value --output text); then
      echo "FAIL  could not read the Cognito client ID from SSM" >&2
      break
    fi
    if ! token_url=$(AWS_PAGER="" aws ssm get-parameter \
      --region "$region" \
      --name "$parameter_prefix/token-endpoint" \
      --query Parameter.Value --output text); then
      echo "FAIL  could not read the Cognito token endpoint from SSM" >&2
      break
    fi
    if [[ "$token_url" != https://* ]]; then
      echo "FAIL  the Cognito token endpoint must use HTTPS" >&2
      break
    fi

    if ! client_secret=$(AWS_PAGER="" aws cognito-idp describe-user-pool-client \
      --region "$region" \
      --user-pool-id "$pool_id" \
      --client-id "$client_id" \
      --query UserPoolClient.ClientSecret --output text); then
      echo "FAIL  could not retrieve the Cognito client secret" >&2
      break
    fi

    curl_user="${client_id}:${client_secret}"
    curl_user="${curl_user//\\/\\\\}"
    curl_user="${curl_user//\"/\\\"}"
    if ! token_response=$(printf 'user = "%s"\n' "$curl_user" | \
      curl --silent --show-error --fail-with-body \
        --config - \
        --request POST "$token_url" \
        --header 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode 'grant_type=client_credentials' \
        --data-urlencode "scope=$scope"); then
      echo "FAIL  Cognito rejected the client-credentials request" >&2
      break
    fi

    if ! token=$(jq -er \
      '.access_token | select(type == "string" and length > 0)' \
      <<<"$token_response"); then
      echo "FAIL  Cognito returned no access token" >&2
      jq -c '{error, error_description}' <<<"$token_response" >&2 || true
      break
    fi

    expires_in=$(jq -r '.expires_in // empty' <<<"$token_response")
    TOKEN="$token"
    export TOKEN
    succeeded=true
    break
  done

  client_secret=""
  curl_user=""
  token_response=""
  token=""

  if [[ "$restore_xtrace" == true ]]; then
    set -x
  fi
  if [[ "$succeeded" != true ]]; then
    return 1
  fi

  echo "PASS  TOKEN exported for stage $stage${expires_in:+ (expires in ${expires_in}s)}" >&2
}

obtain_mcp_token