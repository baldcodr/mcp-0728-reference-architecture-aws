// The template assertion keeps the whitepaper's tracing claims tied to the
// deployment artifacts. Serverless applies REST stage settings after the
// CloudFormation deploy, so fixtures cover both its implicit-stage inputs and
// the explicit Stage shape a future release may synthesize.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "assert-template.mjs");

const tracedFunction = {
  Type: "AWS::Lambda::Function",
  Properties: {
    TracingConfig: { Mode: "Active" },
    Role: { "Fn::GetAtt": ["ExecutionRole", "Arn"] },
  },
};

const executionRole = {
  Type: "AWS::IAM::Role",
  Properties: {
    Policies: [
      {
        PolicyDocument: {
          Statement: [
            {
              Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:DeleteItem"],
              Resource: { "Fn::GetAtt": ["HandlesTable", "Arn"] },
            },
            {
              Effect: "Allow",
              Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
              Resource: { "Fn::GetAtt": ["HandlesTable", "Arn"] },
              Condition: {
                "ForAnyValue:StringEquals": {
                  "dynamodb:EnclosingOperation": ["TransactWriteItems"],
                },
              },
            },
          ],
        },
      },
    ],
  },
};

const restApi = {
  Type: "AWS::ApiGateway::RestApi",
  Properties: {},
};

const integrationMethod = {
  Type: "AWS::ApiGateway::Method",
  Properties: {
    RestApiId: { Ref: "RestApi" },
    Integration: {
      Uri: {
        "Fn::Join": [
          "",
          ["arn:aws:apigateway:lambda:path/functions/", { "Fn::GetAtt": ["F", "Arn"] }],
        ],
      },
    },
  },
};

const invokePermission = {
  Type: "AWS::Lambda::Permission",
  Properties: {
    Action: "lambda:InvokeFunction",
    Principal: "apigateway.amazonaws.com",
    FunctionName: { "Fn::GetAtt": ["F", "Arn"] },
    SourceArn: {
      "Fn::Join": [
        "",
        ["arn:aws:execute-api:eu-west-2:123456789012:", { Ref: "RestApi" }, "/*/*"],
      ],
    },
  },
};

const deployment = {
  Type: "AWS::ApiGateway::Deployment",
  Properties: { StageName: "dev" },
};

const apiGatewayLogGroup = {
  Type: "AWS::Logs::LogGroup",
  Properties: { LogGroupName: "/aws/api-gateway/test-dev" },
};

const loggedStage = {
  Type: "AWS::ApiGateway::Stage",
  Properties: { TracingEnabled: true, AccessLogSetting: { Format: "{}" } },
};

const observableProviderState = {
  service: {
    provider: {
      tracing: { apiGateway: true },
      logs: {
        restApi: {
          accessLogging: true,
          format:
            '{"reqId":"$context.requestId","xrayTraceId":"$context.xrayTraceId","status":"$context.status","clientId":"$context.authorizer.claims.client_id","integrationStatus":"$context.integration.status"}',
        },
      },
    },
  },
};

function runAgainst(
  resources: Record<string, unknown>,
  state: Record<string, unknown> = observableProviderState,
): number {
  const dir = mkdtempSync(join(tmpdir(), "tmpl-"));
  const templateFile = join(dir, "template.json");
  const stateFile = join(dir, "serverless-state.json");
  writeFileSync(
    templateFile,
    JSON.stringify({
      Resources: {
        ExecutionRole: executionRole,
        RestApi: restApi,
        IntegrationMethod: integrationMethod,
        InvokePermission: invokePermission,
        ...resources,
      },
    }),
  );
  writeFileSync(stateFile, JSON.stringify(state));
  try {
    execFileSync("node", [SCRIPT, templateFile, stateFile], { stdio: "pipe" });
    return 0;
  } catch (err) {
    const status = (err as { status: number | null }).status;
    if (status === null) throw err;
    return status;
  }
}

describe("template assertion gate", () => {
  it("passes the implicit stage shape used by Serverless", () => {
    expect(
      runAgainst({ F: tracedFunction, D: deployment, L: apiGatewayLogGroup }),
    ).toBe(0);
  });

  it("passes when a future template carries an explicit configured stage", () => {
    expect(
      runAgainst({
        F: tracedFunction,
        D: deployment,
        L: apiGatewayLogGroup,
        S: loggedStage,
      }),
    ).toBe(0);
  });

  it("ignores framework custom-resource Lambdas", () => {
    expect(
      runAgainst({
        F: tracedFunction,
        D: deployment,
        L: apiGatewayLogGroup,
        CustomResourceRole: {
          Type: "AWS::IAM::Role",
          Properties: { Policies: [] },
        },
        CustomResourceFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Role: { "Fn::GetAtt": ["CustomResourceRole", "Arn"] },
          },
        },
      }),
    ).toBe(0);
  });

  it("fails when function tracing is absent", () => {
    const untraced = { Type: "AWS::Lambda::Function", Properties: {} };
    expect(
      runAgainst({ F: untraced, D: deployment, L: apiGatewayLogGroup }),
    ).toBe(1);
  });

  it("fails when no deployment was synthesized", () => {
    expect(runAgainst({ F: tracedFunction, L: apiGatewayLogGroup })).toBe(1);
  });

  it("fails when no access-log group was synthesized", () => {
    expect(runAgainst({ F: tracedFunction, D: deployment })).toBe(1);
  });

  it("fails when an explicit stage carries no access log format", () => {
    const unlogged = {
      Type: "AWS::ApiGateway::Stage",
      Properties: { TracingEnabled: true },
    };
    expect(
      runAgainst({
        F: tracedFunction,
        D: deployment,
        L: apiGatewayLogGroup,
        S: unlogged,
      }),
    ).toBe(1);
  });

  it("fails when resolved provider state disables gateway tracing", () => {
    const state = {
      service: {
        provider: {
          tracing: { apiGateway: false },
          logs: { restApi: { accessLogging: true, format: "{}" } },
        },
      },
    };
    expect(
      runAgainst(
        { F: tracedFunction, D: deployment, L: apiGatewayLogGroup },
        state,
      ),
    ).toBe(1);
  });

  it("fails when resolved provider state disables access logging", () => {
    const state = {
      service: {
        provider: {
          tracing: { apiGateway: true },
          logs: { restApi: { accessLogging: false, format: "{}" } },
        },
      },
    };
    expect(
      runAgainst(
        { F: tracedFunction, D: deployment, L: apiGatewayLogGroup },
        state,
      ),
    ).toBe(1);
  });

  it("fails when the template contains no functions at all", () => {
    expect(runAgainst({ D: deployment, L: apiGatewayLogGroup })).toBe(1);
  });

  it.each(["dynamodb:Query", "dynamodb:Scan", "dynamodb:TransactWriteItems"])(
    "fails when the execution role grants unexpected %s access",
    (legacyAction) => {
      const staleRole = structuredClone(executionRole);
      staleRole.Properties.Policies[0].PolicyDocument.Statement[0].Action.push(
        legacyAction,
      );
      expect(
        runAgainst({
          F: tracedFunction,
          D: deployment,
          L: apiGatewayLogGroup,
          ExecutionRole: staleRole,
        }),
      ).toBe(1);
    },
  );

  it("fails when a required transaction suboperation is absent", () => {
    const incompleteRole = structuredClone(executionRole);
    incompleteRole.Properties.Policies[0].PolicyDocument.Statement[1].Action = [
      "dynamodb:PutItem",
    ];
    expect(
      runAgainst({
        F: tracedFunction,
        D: deployment,
        L: apiGatewayLogGroup,
        ExecutionRole: incompleteRole,
      }),
    ).toBe(1);
  });

  it("fails when transaction writes can be issued directly", () => {
    const broadRole = structuredClone(executionRole);
    delete broadRole.Properties.Policies[0].PolicyDocument.Statement[1].Condition;
    expect(
      runAgainst({
        F: tracedFunction,
        D: deployment,
        L: apiGatewayLogGroup,
        ExecutionRole: broadRole,
      }),
    ).toBe(1);
  });

  it("fails when DynamoDB access is wildcard scoped", () => {
    const broadRole = structuredClone(executionRole);
    broadRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource =
      "*" as never;
    expect(
      runAgainst({
        F: tracedFunction,
        D: deployment,
        L: apiGatewayLogGroup,
        ExecutionRole: broadRole,
      }),
    ).toBe(1);
  });

  it("fails when the Lambda permission is not scoped to the REST API", () => {
    const broadPermission = structuredClone(invokePermission);
    broadPermission.Properties.SourceArn = "*" as never;
    expect(
      runAgainst({
        F: tracedFunction,
        D: deployment,
        L: apiGatewayLogGroup,
        InvokePermission: broadPermission,
      }),
    ).toBe(1);
  });

  it("fails when the access log cannot be joined by X-Ray root", () => {
    const state = structuredClone(observableProviderState);
    state.service.provider.logs.restApi.format =
      '{"reqId":"$context.requestId","status":"$context.status","clientId":"$context.authorizer.claims.client_id","integrationStatus":"$context.integration.status"}';
    expect(
      runAgainst(
        { F: tracedFunction, D: deployment, L: apiGatewayLogGroup },
        state,
      ),
    ).toBe(1);
  });
});
