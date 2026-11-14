import { create } from "@bufbuild/protobuf";
import { timestampMs, timestampNow } from "@bufbuild/protobuf/wkt";
import { ProviderAccountStatusSchema, type ProviderAccountStatus } from "@canopy/contracts";

/** Display fields are explicitly selected. Output, errors and unknown CLI fields never cross this boundary. */
export function accountText(value: string | null | undefined, secrets: readonly string[] = []): string {
  if (
    !value ||
    value.length > 256 ||
    /\p{Cc}|bearer\s|sk-[\w-]+|gh[pousr]_|eyJ[\w-]+\.|(?:token|secret|api[_ -]?key|password)\s*[:=]|:\/\/.*@|[A-Za-z0-9_+]{40,}/iu.test(
      value,
    )
  )
    return "";

  if (secrets.some((secret) => secret.length >= 4 && value.includes(secret))) return "";

  return value.trim();
}

export function accountEmail(value: string | null | undefined, secrets: readonly string[] = []): string {
  const safe = accountText(value, secrets);

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safe) ? safe : "";
}

/** A copyable command for the worker's actual login home, including paths with shell metacharacters. */
export function providerLoginCommand(
  harness: "claude" | "codex" | "grok",
  account: Pick<ProviderAccountStatus, "loginDir" | "loginExecutable"> &
    Partial<Pick<ProviderAccountStatus, "loginSecureStorageDir">>,
  os: string,
): string {
  if (!account.loginDir) return "";
  const windows = os === "win32";

  const quote = (value: string) =>
    windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;

  const variable = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", grok: "GROK_HOME" }[harness];
  const executable = quote(account.loginExecutable || harness);
  const args = harness === "claude" ? "auth login" : "login";

  const storage =
    harness === "claude" && account.loginSecureStorageDir !== undefined
      ? windows
        ? `$env:CLAUDE_SECURESTORAGE_CONFIG_DIR=${quote(account.loginSecureStorageDir)}; `
        : `CLAUDE_SECURESTORAGE_CONFIG_DIR=${quote(account.loginSecureStorageDir)} `
      : "";

  return windows
    ? `${storage}$env:${variable}=${quote(account.loginDir)}; & ${executable} ${args}`
    : `${storage}${variable}=${quote(account.loginDir)} ${executable} ${args}`;
}

/**
 * The account's sign-in action, named the same on every surface: "Sign in" without a login, "Sign in again" when
 * the login expired or a turn's harness rejected it, "Change account" while it is fine (sign-in replaces it).
 */
export type AccountAction = "sign_in" | "sign_in_again" | "change_account";

export const ACCOUNT_ACTION_LABELS: Record<AccountAction, string> = {
  sign_in: "Sign in",
  sign_in_again: "Sign in again",
  change_account: "Change account",
};

export function accountAction(
  account: Pick<ProviderAccountStatus, "state" | "expiresAt"> | undefined,
  now = Date.now(),
): AccountAction {
  if (account?.state === "expired") return "sign_in_again";

  if (account?.state !== "signed_in" && account?.state !== "stored") return "sign_in";

  return account.expiresAt && timestampMs(account.expiresAt) <= now ? "sign_in_again" : "change_account";
}

/** Under a turn that failed to authenticate the login is never fine, whatever the CLI reports. */
export const rejectedSignInLabel = (account: Pick<ProviderAccountStatus, "state" | "expiresAt"> | undefined): string =>
  ACCOUNT_ACTION_LABELS[accountAction(account) === "sign_in" ? "sign_in" : "sign_in_again"];

/** "expired": a turn's harness rejected this login (the gateway's mark), whatever the CLI's own status says. */
const states = new Set(["signed_in", "signed_out", "expired", "unknown", "error", "stored"]);

export const REJECTED_LOGIN_DETAIL = "The provider rejected this login during a turn. Sign in again.";

const methods = new Set([
  "claude.ai",
  "Subscription account",
  "ChatGPT",
  "API key",
  "API key configured",
  "Proxy",
  "Account",
  "Managed credentials",
]);

const details = new Set([
  "Claude returned an unsupported account status.",
  "Codex returned an unsupported account status.",
  "The account check timed out.",
  "Could not read account status from the CLI.",
  "The instance configuration is unavailable.",
  REJECTED_LOGIN_DETAIL,
]);

/** Apply on both worker and gateway; org IDs and all unknown fields are deliberately absent. */
export function sanitizeAccountStatus(
  value: ProviderAccountStatus,
  secrets: readonly string[] = [],
): ProviderAccountStatus {
  const validDate = (date: ProviderAccountStatus["expiresAt"]) =>
    date && date.seconds > 0n && date.seconds < 253402300800n && date.nanos >= 0 && date.nanos < 1_000_000_000
      ? date
      : undefined;

  return create(ProviderAccountStatusSchema, {
    state: states.has(value.state) ? value.state : "unknown",
    authMethod: methods.has(value.authMethod) ? value.authMethod : "",
    email: accountEmail(value.email, secrets),
    organization: accountText(value.organization, secrets),
    plan: accountText(value.plan, secrets),
    configDir: accountText(value.configDir, secrets),
    loginDir: accountText(value.loginDir, secrets),
    loginExecutable: accountText(value.loginExecutable, secrets),
    ...(value.loginSecureStorageDir !== undefined && {
      loginSecureStorageDir: accountText(value.loginSecureStorageDir, secrets),
    }),
    proxyName: accountText(value.proxyName, secrets),
    detail: details.has(value.detail) ? value.detail : "",
    loginRevision: /^[0-9a-f]{16}$/.test(value.loginRevision) ? value.loginRevision : "",
    loginId: /^[\w-]{1,64}$/.test(value.loginId) ? value.loginId : "",
    loginOutcome: ["pending", "signed_in", "failed"].includes(value.loginOutcome) ? value.loginOutcome : "",
    expiresAt: validDate(value.expiresAt),
    checkedAt: validDate(value.checkedAt) ?? timestampNow(),
  });
}
