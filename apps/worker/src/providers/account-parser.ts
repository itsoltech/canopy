import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate, timestampNow } from "@bufbuild/protobuf/wkt";
import { ProviderAccountStatusSchema, type ProviderAccountStatus } from "@canopy/contracts";
import { z } from "zod";
import { accountText } from "@canopy/domain/provider-accounts";

const claudeStatus = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  email: z.string().nullable().optional(),
  orgName: z.string().nullable().optional(),
  subscriptionType: z.string().nullable().optional(),
  loginExpiresAt: z
    .union([
      z.iso.datetime({ offset: true }),
      z
        .number()
        .positive()
        .max(253402300799999)
        .transform((value) => new Date(value < 1e12 ? value * 1000 : value).toISOString()),
    ])
    .nullable()
    .optional(),
});

const loginFiles = { claude: ".credentials.json", codex: "auth.json", grok: "auth.json" };

/** Changes when the CLI writes its login file (a new sign-in, a token refresh); metadata only, never the content. */
export function loginRevision(harness: keyof typeof loginFiles, loginDir: string): string {
  if (!loginDir) return "";

  try {
    const stat = statSync(join(loginDir, loginFiles[harness]), { bigint: true });

    return createHash("sha256").update(`${stat.ino}:${stat.size}:${stat.mtimeNs}`).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

export function accountResult(state: string, configDir: string, detail = ""): ProviderAccountStatus {
  return create(ProviderAccountStatusSchema, {
    state,
    configDir: accountText(configDir),
    detail,
    checkedAt: timestampNow(),
  });
}

export function parseClaudeAccount(text: string, configDir: string, secrets: readonly string[]): ProviderAccountStatus {
  const parsed = claudeStatus.safeParse(JSON.parse(text));

  if (!parsed.success) return accountResult("error", configDir, "Claude returned an unsupported account status.");
  const data = parsed.data;
  const status = accountResult(data.loggedIn ? "signed_in" : "signed_out", configDir);
  status.authMethod =
    data.authMethod === "api_key"
      ? "API key"
      : data.authMethod === "claude.ai"
        ? "claude.ai"
        : data.authMethod === "oauth_token"
          ? "Subscription account"
          : data.loggedIn
            ? "Account"
            : "";
  status.email = accountText(data.email, secrets);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(status.email)) status.email = "";
  status.organization = accountText(data.orgName, secrets);
  status.plan = accountText(data.subscriptionType, secrets);

  if (data.loginExpiresAt !== undefined && data.loginExpiresAt !== null) {
    const expiry = new Date(data.loginExpiresAt);

    if (Number.isFinite(expiry.getTime())) status.expiresAt = timestampFromDate(expiry);
  }

  return status;
}

export function parseCodexAccount(text: string, code: number | null, configDir: string): ProviderAccountStatus {
  if (/(?:^|\n)Not logged in(?:\r?\n|$)/.test(text)) return accountResult("signed_out", configDir);

  if (code === 0 && /(?:^|\n)Logged in using ChatGPT(?:\r?\n|$)/.test(text)) {
    const status = accountResult("signed_in", configDir);
    status.authMethod = "ChatGPT";

    return status;
  }

  if (code === 0 && /(?:Logged in using an API key|API key configured)/.test(text)) {
    const status = accountResult("signed_in", configDir);
    status.authMethod = "API key";

    return status;
  }

  if (
    code === 0 &&
    /Logged in using (?:workload identity|access token|personal access token|Amazon Bedrock)/.test(text)
  ) {
    const status = accountResult("signed_in", configDir);
    status.authMethod = "Managed credentials";

    return status;
  }

  return accountResult("error", configDir, "Codex returned an unsupported account status.");
}
