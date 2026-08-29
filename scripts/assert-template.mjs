// Layer-2 gate: assert the synthesized service carries everything Serverless
// uses to configure tracing and access logging.
//
// Serverless currently creates the stage through AWS::ApiGateway::Deployment,
// then applies stage settings with its post-deploy updateStage call. The
// resolved provider state is therefore part of the deploy artifact even though
// CloudFormation contains no explicit AWS::ApiGateway::Stage resource.
//
// Usage: node scripts/assert-template.mjs [path-to-template] [path-to-state]

import { readFileSync } from "node:fs";

const templatePath =
  process.argv[2] ?? ".serverless/cloudformation-template-update-stack.json";
const statePath = process.argv[3] ?? ".serverless/serverless-state.json";
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const state = JSON.parse(readFileSync(statePath, "utf8"));
const resourceMap = template.Resources ?? {};
const resources = Object.values(resourceMap);
const provider = state.service?.provider ?? {};
const DIRECT_DYNAMODB_ACTIONS = new Set([
  "dynamodb:DeleteItem",
  "dynamodb:GetItem",
]);
const TRANSACTION_DYNAMODB_ACTIONS = new Set([
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
]);
const REQUIRED_DYNAMODB_ACTIONS = new Set([
  ...DIRECT_DYNAMODB_ACTIONS,
  ...TRANSACTION_DYNAMODB_ACTIONS,
]);

let failed = false;
const fail = (msg) => {
  console.error("ASSERT FAIL:", msg);
  failed = true;
};

const lambdaEntries = Object.entries(resourceMap).filter(
  ([, resource]) => resource.Type === "AWS::Lambda::Function",
);
const apiGatewayMethods = resources.filter(
  (resource) => resource.Type === "AWS::ApiGateway::Method",
);
const functionEntries = lambdaEntries.filter(([logicalId]) =>
  apiGatewayMethods.some((method) =>
    referencesLogicalId(method.Properties?.Integration?.Uri, logicalId),
  ),
);
const functions = functionEntries.map(([, resource]) => resource);
if (functions.length === 0) {
  fail("no API Gateway-integrated Lambda functions in template");
} else if (
  !functions.some((r) => r.Properties?.TracingConfig?.Mode === "Active")
) {
  fail("no function has TracingConfig.Mode Active");
}

const asArray = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function referencedRoleId(role) {
  if (typeof role?.Ref === "string") return role.Ref;
  const getAtt = role?.["Fn::GetAtt"];
  if (Array.isArray(getAtt)) return getAtt[0];
  if (typeof getAtt === "string") return getAtt.split(".")[0];
  return undefined;
}

function isHandlesTableArn(resource) {
  const getAtt = resource?.["Fn::GetAtt"];
  return (
    (Array.isArray(getAtt) &&
      getAtt[0] === "HandlesTable" &&
      getAtt[1] === "Arn") ||
    getAtt === "HandlesTable.Arn"
  );
}

function isTransactWriteOnly(statement) {
  const condition = statement.Condition;
  if (!condition || Object.keys(condition).length !== 1) return false;
  const equals = condition["ForAnyValue:StringEquals"];
  if (!equals || Object.keys(equals).length !== 1) return false;
  const operations = asArray(equals["dynamodb:EnclosingOperation"]);
  return operations.length === 1 && operations[0] === "TransactWriteItems";
}

const roleIds = new Set(
  functions
    .map((fn) => referencedRoleId(fn.Properties?.Role))
    .filter(Boolean),
);
if (functions.length > 0 && roleIds.size === 0) {
  fail("cannot resolve any Lambda execution role from the template");
}

for (const roleId of roleIds) {
  const role = resourceMap[roleId];
  if (role?.Type !== "AWS::IAM::Role") {
    fail(`Lambda execution role ${roleId} is not rendered as AWS::IAM::Role`);
    continue;
  }

  const statements = asArray(role.Properties?.Policies).flatMap((policy) =>
    asArray(policy.PolicyDocument?.Statement),
  );
  const dynamodbStatements = statements.filter(
    (statement) =>
      statement.Effect === "Allow" &&
      asArray(statement.Action).some(
        (action) =>
          typeof action === "string" && action.startsWith("dynamodb:"),
      ),
  );
  const actualActions = new Set(
    dynamodbStatements.flatMap((statement) =>
      asArray(statement.Action).filter(
        (action) =>
          typeof action === "string" && action.startsWith("dynamodb:"),
      ),
    ),
  );

  for (const action of REQUIRED_DYNAMODB_ACTIONS) {
    if (!actualActions.has(action)) {
      fail(`${roleId} is missing required action ${action}`);
    }
  }
  for (const action of actualActions) {
    if (!REQUIRED_DYNAMODB_ACTIONS.has(action)) {
      fail(`${roleId} grants unexpected action ${action}`);
    }
  }
  for (const action of DIRECT_DYNAMODB_ACTIONS) {
    const grants = dynamodbStatements.filter((statement) =>
      asArray(statement.Action).includes(action),
    );
    if (!grants.some((statement) => statement.Condition === undefined)) {
      fail(`${roleId} does not grant direct action ${action}`);
    }
  }
  for (const action of TRANSACTION_DYNAMODB_ACTIONS) {
    const grants = dynamodbStatements.filter((statement) =>
      asArray(statement.Action).includes(action),
    );
    if (!grants.every(isTransactWriteOnly)) {
      fail(`${roleId} grants ${action} outside TransactWriteItems`);
    }
  }
  for (const statement of dynamodbStatements) {
    const targets = asArray(statement.Resource);
    if (targets.length === 0 || !targets.every(isHandlesTableArn)) {
      fail(`${roleId} DynamoDB access is not scoped only to HandlesTable.Arn`);
    }
  }
}

function referencesLogicalId(value, logicalId) {
  if (Array.isArray(value)) {
    return value.some((part) => referencesLogicalId(part, logicalId));
  }
  if (!value || typeof value !== "object") return false;
  if (value.Ref === logicalId) return true;
  const getAtt = value["Fn::GetAtt"];
  if (
    (Array.isArray(getAtt) && getAtt[0] === logicalId) ||
    (typeof getAtt === "string" && getAtt.split(".")[0] === logicalId)
  ) {
    return true;
  }
  return Object.values(value).some((part) =>
    referencesLogicalId(part, logicalId),
  );
}

const restApiIds = Object.entries(resourceMap)
  .filter(([, resource]) => resource.Type === "AWS::ApiGateway::RestApi")
  .map(([logicalId]) => logicalId);
const apiGatewayPermissions = resources.filter(
  (resource) =>
    resource.Type === "AWS::Lambda::Permission" &&
    resource.Properties?.Action === "lambda:InvokeFunction" &&
    resource.Properties?.Principal === "apigateway.amazonaws.com",
);
for (const [functionId] of functionEntries) {
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

const deployments = resources.filter(
  (r) => r.Type === "AWS::ApiGateway::Deployment",
);
if (deployments.length === 0) {
  fail("no ApiGateway deployment in template");
}

const apiGatewayLogGroups = resources.filter(
  (r) =>
    r.Type === "AWS::Logs::LogGroup" &&
    typeof r.Properties?.LogGroupName === "string" &&
    r.Properties.LogGroupName.startsWith("/aws/api-gateway/"),
);
if (apiGatewayLogGroups.length === 0) {
  fail("no ApiGateway access-log group in template");
}

if (provider.tracing?.apiGateway !== true) {
  fail("resolved provider state does not enable ApiGateway tracing");
}

const restApiLogs = provider.logs?.restApi;
if (!restApiLogs || restApiLogs.accessLogging === false) {
  fail("resolved provider state does not enable ApiGateway access logging");
} else if (
  typeof restApiLogs.format !== "string" ||
  restApiLogs.format.length === 0
) {
  fail("resolved provider state has no ApiGateway access-log format");
} else {
  for (const variable of [
    "$context.requestId",
    "$context.xrayTraceId",
    "$context.status",
    "$context.authorizer.claims.client_id",
    "$context.integration.status",
  ]) {
    if (!restApiLogs.format.includes(variable)) {
      fail(`ApiGateway access-log format is missing ${variable}`);
    }
  }
}

const stages = resources.filter((r) => r.Type === "AWS::ApiGateway::Stage");
if (
  stages.length > 0 &&
  !stages.some((stage) => stage.Properties?.TracingEnabled === true)
) {
  fail("explicit stage TracingEnabled is not true");
}
if (
  stages.length > 0 &&
  !stages.some((stage) => stage.Properties?.AccessLogSetting?.Format)
) {
  fail("explicit stage AccessLogSetting.Format is missing");
}

if (failed) process.exit(1);
console.log(
  `template assertions passed: ${functions.length} function(s) traced, transaction-scoped DynamoDB IAM and ApiGateway observability configured`,
);
