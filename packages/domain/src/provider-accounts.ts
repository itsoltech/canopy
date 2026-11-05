import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
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

const states = new Set(["signed_in", "signed_out", "unknown", "error"]);

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
    proxyName: accountText(value.proxyName, secrets),
    detail: details.has(value.detail) ? value.detail : "",
    expiresAt: validDate(value.expiresAt),
    checkedAt: validDate(value.checkedAt) ?? timestampNow(),
  });
}
