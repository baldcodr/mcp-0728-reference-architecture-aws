import {
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { CognitoJwtVerifier } from "aws-jwt-verify";

export interface CognitoVerifierConfig {
  userPoolId: string;
  clientId: string;
}

export interface CognitoAccessTokenClaims {
  client_id?: unknown;
  scope?: unknown;
  exp?: unknown;
}

export interface CognitoAccessTokenVerifier {
  verify(token: string): Promise<CognitoAccessTokenClaims>;
}

function defaultCognitoVerifier(
  config: CognitoVerifierConfig,
): CognitoAccessTokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: "access",
    clientId: config.clientId,
    includeRawJwtInErrors: false,
  });
  return { verify: (token) => verifier.verify(token) };
}

export function createCognitoTokenVerifier(
  config: CognitoVerifierConfig,
  cognitoVerifier = defaultCognitoVerifier(config),
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      try {
        const claims = await cognitoVerifier.verify(token);
        if (
          claims.client_id !== config.clientId ||
          typeof claims.scope !== "string" ||
          typeof claims.exp !== "number"
        ) {
          throw new Error("invalid verified claims");
        }

        return {
          token,
          clientId: claims.client_id,
          scopes: claims.scope.split(/\s+/).filter(Boolean),
          expiresAt: claims.exp,
        };
      } catch {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "Invalid access token",
        );
      }
    },
  };
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: "COGNITO_USER_POOL_ID" | "COGNITO_CLIENT_ID",
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function createCognitoTokenVerifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OAuthTokenVerifier {
  return createCognitoTokenVerifier({
    userPoolId: requiredEnv(env, "COGNITO_USER_POOL_ID"),
    clientId: requiredEnv(env, "COGNITO_CLIENT_ID"),
  });
}
