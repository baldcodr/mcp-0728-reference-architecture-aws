output "user_pool_arn" {
  value = aws_cognito_user_pool.mcp.arn
}

output "user_pool_id" {
  value = aws_cognito_user_pool.mcp.id
}

output "m2m_client_id" {
  value = aws_cognito_user_pool_client.m2m.id
}

output "token_endpoint" {
  value = "https://${aws_cognito_user_pool_domain.mcp.domain}.auth.${var.aws_region}.amazoncognito.com/oauth2/token"
}

output "web_acl_arn" {
  value = var.enable_waf ? aws_wafv2_web_acl.mcp[0].arn : null
}

output "audit_log_group" {
  value = var.enable_data_audit ? aws_cloudwatch_log_group.audit[0].name : null
}
