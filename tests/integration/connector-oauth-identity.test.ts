import { expect, test } from "bun:test";
import { recordOAuthIdentity } from "../../apps/gateway/src/connectors/oauth-identity.ts";
import type { Credentials } from "../../apps/gateway/src/connectors/records.ts";
import { accountIdentity, connectorIdentity } from "../../apps/gateway/src/config-sync/connector-values.ts";

test("OAuth account matching requires a common issuer and subject and preserves scope on partial refresh", () => {
  const principal = { workspace_id: "work", sub: "person" };
  const credentials: Credentials = {};

  const account = (value: Credentials) =>
    connectorIdentity("connector", {
      type: "notion",
      url: "https://example.test/mcp",
      name: "Work",
      authKind: "oauth",
      accountIdentity: accountIdentity(value),
    });

  const first = "https://issuer.example.test/first";
  recordOAuthIdentity("notion", credentials, principal, first);
  const original = account(credentials);
  expect(original).toBeTruthy();
  const second: Credentials = {};
  recordOAuthIdentity("notion", second, principal, "https://issuer.example.test/second");
  expect(account(second)).not.toBe(original);
  recordOAuthIdentity("notion", credentials, { sub: "person" }, first);
  expect(account(credentials)).toBe(original);
  expect(() => recordOAuthIdentity("notion", credentials, { sub: "different" }, first)).toThrow();
  expect(account(credentials)).toBe(original);
  const legacy: Credentials = { accountIdentity: "a".repeat(64) };
  expect(account(legacy)).toBe("");
});
