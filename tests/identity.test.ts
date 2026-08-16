import { describe, expect, it, vi } from "vitest";
import {
  createCognitoTokenVerifier,
  createCognitoTokenVerifierFromEnv,
  type CognitoAccessTokenVerifier,
} from "../src/identity.js";

const CONFIG = {
  userPoolId: "eu-west-2_example",
  clientId: "m2m-client",
};

describe("createCognitoTokenVerifier", () => {
  it("maps verified M2M claims into MCP auth info", async () => {
    const verify = vi.fn(async () => ({
      client_id: CONFIG.clientId,
      scope: "mcp-ref/tools.invoke audit.read",
      exp: 2_000_000_000,
    }));
    const verifier = createCognitoTokenVerifier(CONFIG, { verify });

    await expect(verifier.verifyAccessToken("signed-token")).resolves.toEqual({
      token: "signed-token",
      clientId: CONFIG.clientId,
      scopes: ["mcp-ref/tools.invoke", "audit.read"],
      expiresAt: 2_000_000_000,
    });
    expect(verify).toHaveBeenCalledWith("signed-token");
  });

  it.each([
    ["wrong client", { client_id: "other", scope: "scope", exp: 2_000_000_000 }],
    ["missing scope", { client_id: CONFIG.clientId, exp: 2_000_000_000 }],
    ["missing expiry", { client_id: CONFIG.clientId, scope: "scope" }],
  ])("rejects %s after verification", async (_label, claims) => {
    const cognitoVerifier: CognitoAccessTokenVerifier = {
      verify: async () => claims,
    };
    const verifier = createCognitoTokenVerifier(CONFIG, cognitoVerifier);

    await expect(verifier.verifyAccessToken("token")).rejects.toMatchObject({
      code: "invalid_token",
      message: "Invalid access token",
    });
  });

  it("does not expose verifier diagnostics or token contents", async () => {
    const verifier = createCognitoTokenVerifier(CONFIG, {
      verify: async () => {
        throw new Error("signature failed for secret-token-value");
      },
    });

    try {
      await verifier.verifyAccessToken("secret-token-value");
      throw new Error("expected verification to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_token",
        message: "Invalid access token",
      });
      expect(String(error)).not.toContain("secret-token-value");
      expect(String(error)).not.toContain("signature failed");
    }
  });
});

describe("createCognitoTokenVerifierFromEnv", () => {
  it.each(["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"])(
    "requires %s",
    (missing) => {
      const env = {
        COGNITO_USER_POOL_ID: "eu-west-2_example",
        COGNITO_CLIENT_ID: "m2m-client",
      } as NodeJS.ProcessEnv;
      delete env[missing];

      expect(() => createCognitoTokenVerifierFromEnv(env)).toThrow(
        `${missing} is not set`,
      );
    },
  );
});