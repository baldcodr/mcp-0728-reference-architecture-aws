variable "aws_region" {
  description = "Region for the foundation resources. Must match the serverless deploy region."
  type        = string
  default     = "eu-west-2"
}

variable "name_prefix" {
  description = "Prefix for resource names and the SSM parameter namespace. Must match the service name in serverless.yml."
  type        = string
  default     = "mcp-ref"
}

variable "stage" {
  description = "Stage name. Must match the serverless deploy stage."
  type        = string
  default     = "dev"
}

variable "xray_sampling_rate" {
  description = "Fraction of MCP requests traced end to end. 1.0 in dev makes every claim checkable; lower it in prod, X-Ray charges per trace recorded."
  type        = number
  default     = 1.0
}

variable "enable_data_audit" {
  description = "Create a CloudTrail data-event trail on the handle table plus its S3 and CloudWatch Logs destinations. Set false when an org-wide trail already captures DynamoDB data events."
  type        = bool
  default     = true
}

variable "audit_retention_days" {
  description = "How long CloudTrail data-event records are kept, in S3 and in the log group. Set this to your evidence-retention obligation; the default suits a dev reference deployment."
  type        = number
  default     = 90
}

variable "enable_waf" {
  description = "Create a WAFv2 web ACL with a rate-based rule for the MCP endpoint."
  type        = bool
  default     = false
}

variable "waf_rate_limit" {
  description = "Requests per 5-minute window per source IP before WAF blocks."
  type        = number
  default     = 300
}

variable "api_stage_arn" {
  description = <<-EOT
    ARN of the deployed API Gateway stage to associate the web ACL with, e.g.
    arn:aws:apigateway:eu-west-2::/restapis/<rest-api-id>/stages/dev.
    The stage exists only after the first serverless deploy, so WAF
    association is a deliberate second apply: terraform apply, serverless
    deploy, then terraform apply again with this variable set.
  EOT
  type        = string
  default     = ""
}
