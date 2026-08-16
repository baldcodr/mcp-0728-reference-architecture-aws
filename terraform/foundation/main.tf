# Foundation stack. Owned by the platform team, long-lived, shared.
#
# Holds identity (Cognito) and edge protection (WAF), the resources whose
# lifecycle should not be coupled to application deploys: deleting a user
# pool invalidates every issued token and every registered client, so it
# must not disappear because someone ran serverless remove.
#
# The contract with the application stack is four SSM parameters under
# /<name_prefix>/<stage>/. The serverless.yml reads user-pool-arn at
# package time. No cross-stack state references in either direction.

data "aws_caller_identity" "current" {}

locals {
  qualified = "${var.name_prefix}-${var.stage}"
}

# ---------------------------------------------------------------------------
# Identity: Cognito user pool with a machine-to-machine client.
#
# Cognito has no dynamic client registration, which makes it a fit for
# exactly this shape: pre-registered enterprise callers using the
# client_credentials grant. Interactive discover-then-register OAuth is a
# protocol-level concern and out of scope here.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "mcp" {
  name = local.qualified

  # No self-service sign-up: clients are provisioned, not registered.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }
}

resource "aws_cognito_resource_server" "mcp" {
  user_pool_id = aws_cognito_user_pool.mcp.id
  identifier   = var.name_prefix
  name         = "${local.qualified}-tools"

  scope {
    scope_name        = "tools.invoke"
    scope_description = "Invoke MCP tools on the ${var.name_prefix} server"
  }
}

# The hosted domain exists only to expose the /oauth2/token endpoint for
# the client_credentials grant.
resource "aws_cognito_user_pool_domain" "mcp" {
  domain       = "${local.qualified}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.mcp.id
}

resource "aws_cognito_user_pool_client" "m2m" {
  name         = "${local.qualified}-m2m"
  user_pool_id = aws_cognito_user_pool.mcp.id

  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["client_credentials"]
  allowed_oauth_scopes                 = ["${aws_cognito_resource_server.mcp.identifier}/tools.invoke"]

  depends_on = [aws_cognito_resource_server.mcp]
}

# ---------------------------------------------------------------------------
# Contract parameters. The client secret is deliberately NOT written here;
# retrieve it on demand with:
#   aws cognito-idp describe-user-pool-client \
#     --user-pool-id <id> --client-id <id> \
#     --query 'UserPoolClient.ClientSecret'
# ---------------------------------------------------------------------------

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
}

# ---------------------------------------------------------------------------
# Observability: X-Ray sampling and the independent audit trail.
#
# The sampling rule drives the gateway, which owns the sampling decision on
# this path; the function honors whatever the gateway decided.
#
# The CloudTrail data-event trail is the auditor that does not trust the
# function: it records every item-level call against the handle table from
# outside the workload, so "only the execution role, only three actions" is
# checkable against a record the function cannot edit. Delivery goes to S3
# (durable) and CloudWatch Logs (queryable with Logs Insights).
# ---------------------------------------------------------------------------

resource "aws_xray_sampling_rule" "mcp" {
  rule_name      = local.qualified
  priority       = 100
  version        = 1
  fixed_rate     = var.xray_sampling_rate
  reservoir_size = 1
  service_name   = "*"
  service_type   = "*"
  host           = "*"
  http_method    = "*"
  url_path       = "*/mcp"
  resource_arn   = "*"
}

locals {
  # Matches TableName in serverless.yml: ${self:service}-${sls:stage}-handles.
  handles_table_arn = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-${var.stage}-handles"
  audit_trail_arn   = "arn:aws:cloudtrail:${var.aws_region}:${data.aws_caller_identity.current.account_id}:trail/${local.qualified}-audit"
}

resource "aws_s3_bucket" "audit" {
  count = var.enable_data_audit ? 1 : 0
  # checkov:skip=CKV2_AWS_6:Public access block is a separate resource below.
  # checkov:skip=CKV_AWS_21:Versioning is a separate resource below.
  # checkov:skip=CKV2_AWS_61:Lifecycle configuration is a separate resource below.
  # These three fail only because count breaks checkov graph linkage; the same
  # configuration with count removed scans clean.

  # checkov:skip=CKV_AWS_18:Access logging on the audit bucket needs a second
  # bucket and a recursion guard; CloudTrail's own log file validation plus
  # versioning covers tamper detection for a reference deployment.
  # checkov:skip=CKV_AWS_144:Cross-region replication is a resilience posture
  # decision for the adopting organization, not a property of this pattern.
  # checkov:skip=CKV_AWS_145:SSE-S3 is used to keep the reference deployable
  # with no KMS key and no per-request key charges. Use a CMK in production.
  # checkov:skip=CKV2_AWS_62:Event notifications on audit delivery are an
  # integration choice (SIEM forwarding) left to the adopter.
  bucket = "${local.qualified}-audit-${data.aws_caller_identity.current.account_id}"
  # Reference-repo convenience. Production audit trails keep their history.
  force_destroy = true
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  count = var.enable_data_audit ? 1 : 0

  bucket = aws_s3_bucket.audit[0].id

  rule {
    id     = "expire-audit-objects"
    status = "Enabled"

    filter {}

    expiration {
      days = var.audit_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  count = var.enable_data_audit ? 1 : 0

  bucket                  = aws_s3_bucket.audit[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit" {
  count = var.enable_data_audit ? 1 : 0

  bucket = aws_s3_bucket.audit[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  count = var.enable_data_audit ? 1 : 0

  bucket = aws_s3_bucket.audit[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "audit_bucket" {
  count = var.enable_data_audit ? 1 : 0

  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit[0].arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit[0].arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  count = var.enable_data_audit ? 1 : 0

  bucket = aws_s3_bucket.audit[0].id
  policy = data.aws_iam_policy_document.audit_bucket[0].json
}

resource "aws_cloudwatch_log_group" "audit" {
  count = var.enable_data_audit ? 1 : 0

  # checkov:skip=CKV_AWS_158:Log group encryption with a CMK is an adopter
  # decision; it adds a KMS key and its charges to a reference deployment.
  # checkov:skip=CKV_AWS_338:Retention is driven by audit_retention_days so
  # the adopter sets it to their evidence-retention obligation.
  name              = "/aws/cloudtrail/${local.qualified}-audit"
  retention_in_days = var.audit_retention_days
}

data "aws_iam_policy_document" "audit_assume" {
  count = var.enable_data_audit ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "audit" {
  count = var.enable_data_audit ? 1 : 0

  name               = "${local.qualified}-cloudtrail-to-logs"
  assume_role_policy = data.aws_iam_policy_document.audit_assume[0].json
}

data "aws_iam_policy_document" "audit_logs" {
  count = var.enable_data_audit ? 1 : 0

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.audit[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "audit" {
  count = var.enable_data_audit ? 1 : 0

  name   = "deliver-to-log-group"
  role   = aws_iam_role.audit[0].id
  policy = data.aws_iam_policy_document.audit_logs[0].json
}

resource "aws_cloudtrail" "audit" {
  count = var.enable_data_audit ? 1 : 0
  # checkov:skip=CKV2_AWS_10:cloud_watch_logs_group_arn is set below. Fails only
  # because count breaks checkov graph linkage.

  # checkov:skip=CKV_AWS_67:Deliberately single-region. This trail audits one
  # regional DynamoDB table; a multi-region trail would duplicate an
  # organization trail's coverage at extra cost.
  # checkov:skip=CKV_AWS_252:SNS notification per delivery is not used; the
  # CloudWatch Logs destination is the queryable path and the alerting hook.
  # checkov:skip=CKV_AWS_35:KMS CMK encryption of trail objects is an adopter
  # decision; log file validation provides the tamper evidence here.
  name                          = "${local.qualified}-audit"
  s3_bucket_name                = aws_s3_bucket.audit[0].id
  include_global_service_events = false
  is_multi_region_trail         = false
  enable_log_file_validation    = true
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.audit[0].arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.audit[0].arn

  advanced_event_selector {
    name = "handle-table-item-operations"

    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }

    field_selector {
      field  = "resources.type"
      equals = ["AWS::DynamoDB::Table"]
    }

    field_selector {
      field  = "resources.ARN"
      equals = [local.handles_table_arn]
    }
  }

  depends_on = [aws_s3_bucket_policy.audit]
}

# ---------------------------------------------------------------------------
# Edge protection: rate-based WAF rule (optional, two-phase).
# The association targets the API stage, which exists only after the first
# serverless deploy. See variables.tf (api_stage_arn) for the sequence.
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "mcp" {
  # checkov:skip=CKV2_AWS_31:WAF logging destination (Firehose or log group) is
  # an adopter choice; the rule here exists to demonstrate the two-phase
  # association, not to prescribe a logging pipeline.
  count = var.enable_waf ? 1 : 0

  name  = local.qualified
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.qualified}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.qualified
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "mcp" {
  count = var.enable_waf && var.api_stage_arn != "" ? 1 : 0

  resource_arn = var.api_stage_arn
  web_acl_arn  = aws_wafv2_web_acl.mcp[0].arn
}
