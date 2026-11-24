import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@canopy/domain";
import { Option, Schema } from "effect";
import { recordProbe } from "./instance-probe.ts";

const marker = "synthetic-codex-login-";
export const selectedAccount = "selected-workspace";
export const initialLogin = "initial";
export const refreshedLogin = "refreshed";
export const cliConfig = '[mcp_servers.device-only]\ncommand = "device-only"\n';
export const profileFlag = 'fixture_profile="selected"';

export function fixtureToken(account: string, generation: string): string {
  const claims = {
    "https://api.openai.com/auth": {
      chatgpt_account_id: account,
      chatgpt_user_id: `user-${account}`,
      chatgpt_plan_type: "plus",
    },
  };

  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${marker}${generation}-${account}`;
}

export function fixtureLogin(account: string, generation: string): string {
  return JSON.stringify({ tokens: { access_token: fixtureToken(account, generation), account_id: account } });
}

export function hasFixtureToken(content: string | Buffer): boolean {
  return content.includes(marker);
}

const statusParams = Schema.decodeUnknownSync(
  Schema.Struct({ includeToken: Schema.Boolean, refreshToken: Schema.optional(Schema.NullOr(Schema.Boolean)) }),
);

const credential = Schema.Struct({
  accessToken: Schema.String,
  chatgptAccountId: Schema.String,
  chatgptPlanType: Schema.optional(Schema.NullOr(Schema.String)),
});

const loginParams = Schema.decodeUnknownOption(Schema.Struct({ ...credential.fields, type: Schema.String }));

const readTokens = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ tokens: Schema.Struct({ access_token: Schema.String, account_id: Schema.String }) }),
  ),
);

const refreshId = "fixture-refresh";

function mockBotLogin(send: (message: JsonObject) => void) {
  return {
    handle(id: number | string, method: string | undefined, params: JsonObject) {
      const apiKey = `${marker}bot-fixture-api-key`;

      if (method === "getAuthStatus") {
        send({ id, result: { authMethod: "apikey", authToken: apiKey, requiresOpenaiAuth: true } });

        return true;
      }

      if (method === "account/login/start" && params["type"] === "apiKey" && params["apiKey"] === apiKey) {
        send({ id, result: { type: "apiKey" } });

        return true;
      }

      return false;
    },
    authorizeTurn: () => true,
  };
}

/** The ordinary and bot processes speak the same app-server protocol but use different credential stores. */
export function instanceCodexLogin(home: string, send: (message: JsonObject) => void) {
  const account = process.env["LOGIN_FIXTURE_ACCOUNT"] ?? "";

  if (!account) return process.env["BOT_TRACE"] ? mockBotLogin(send) : undefined;
  const bot = home === process.env["HOME"] && home === process.env["USERPROFILE"];
  const auth = join(home, "auth.json");
  let externalToken: string | undefined;
  let finishRefresh: ((result: boolean) => void) | undefined;

  const isolated = () =>
    ["auth.json", "auth.lock", "auth.json.lock", "config.toml", "plugins"].every(
      (name) => !lstatSync(join(home, name), { throwIfNoEntry: false }),
    ) &&
    process.argv.includes('cli_auth_credentials_store="ephemeral"') &&
    !process.argv.includes(profileFlag) &&
    !hasFixtureToken(JSON.stringify([process.argv, process.env]));

  function handle(id: number | string, method: string | undefined, params: JsonObject): boolean {
    if (id === refreshId && method === undefined) {
      const valid =
        params["accessToken"] === fixtureToken(selectedAccount, refreshedLogin) &&
        params["chatgptAccountId"] === selectedAccount &&
        isolated();

      if (valid) recordProbe("codex", "external-refresh");
      finishRefresh?.(valid);

      return true;
    }

    if (method === "accountSession/list" && !bot && params["refreshWorkspaceMetadata"] === false) {
      const tokens = existsSync(auth) ? readTokens(readFileSync(auth, "utf8")).tokens : undefined;
      const sessionId = "fixture-session";

      send({
        id,
        result: {
          activeSessionId: tokens ? sessionId : null,
          sessions: tokens
            ? [
                {
                  sessionId,
                  isActive: true,
                  userId: `user-${tokens.account_id}`,
                  selectedWorkspaceAccountId: tokens.account_id,
                },
              ]
            : [],
        },
      });

      return true;
    }

    if (method === "getAuthStatus" && !bot && existsSync(auth)) {
      if (account === selectedAccount && !process.argv.includes(profileFlag)) {
        send({ id, error: { code: -32000, message: "Selected profile launch argument missing" } });

        return true;
      }

      const { includeToken, refreshToken } = statusParams(params);
      const { tokens } = readTokens(readFileSync(auth, "utf8"));

      const rotate =
        includeToken && refreshToken === true && tokens.access_token === fixtureToken(account, initialLogin);

      const authToken = rotate ? fixtureToken(account, refreshedLogin) : tokens.access_token;

      if (rotate) {
        const replacement = `${auth}.new`;
        writeFileSync(replacement, fixtureLogin(account, refreshedLogin));
        renameSync(replacement, auth);
      }

      if (includeToken) recordProbe("codex", refreshToken ? "source-refresh" : "source-token");
      send({
        id,
        result: { authMethod: "chatgpt", authToken: includeToken ? authToken : null, requiresOpenaiAuth: true },
      });

      return true;
    }

    if (method === "account/read" && !bot && existsSync(auth)) {
      send({ id, result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } });

      return true;
    }

    if (method === "account/login/start" && bot) {
      const incoming = Option.getOrUndefined(loginParams(params));

      if (
        incoming?.type !== "chatgptAuthTokens" ||
        incoming.chatgptAccountId !== selectedAccount ||
        ![initialLogin, refreshedLogin].some(
          (generation) => incoming.accessToken === fixtureToken(selectedAccount, generation),
        ) ||
        !isolated()
      ) {
        send({ id, error: { code: -32000, message: "Incorrect bot login or isolation" } });

        return true;
      }

      externalToken = incoming.accessToken;
      recordProbe("codex", "external-login");
      send({ id, result: { type: "chatgptAuthTokens" } });

      return true;
    }

    return false;
  }

  async function authorizeTurn(text: string): Promise<boolean> {
    if (!bot) return existsSync(auth) && readTokens(readFileSync(auth, "utf8")).tokens.account_id === account;

    if (!isolated()) return false;

    if (text.includes("REQUEST_FIXTURE_REFRESH")) {
      if (externalToken !== fixtureToken(selectedAccount, initialLogin)) return false;
      const refresh = Promise.withResolvers<boolean>();
      finishRefresh = refresh.resolve;
      send({
        id: refreshId,
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: selectedAccount },
      });

      return refresh.promise;
    }

    return externalToken === fixtureToken(selectedAccount, refreshedLogin);
  }

  return { handle, authorizeTurn };
}
