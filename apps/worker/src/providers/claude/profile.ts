import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Env, ResolvedProfile } from "../profiles.ts";

/** Variables that would compete with the profile's auth or endpoint. */
const AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Claude Agent SDK options derived from a provider profile.
 *
 * - `env` replaces the subprocess environment (the SDK does not merge it with process.env),
 *   so the base env is copied and auth variables are swapped per thread. No global mutation,
 *   threads with different profiles can run side by side. The profile's own variables go over the base env
 *   (the worker's variables they may not touch are refused earlier, @canopy/domain env rules).
 * - User settings (~/.claude/settings.json) are not loaded: they may set their own `env`
 *   (ANTHROPIC_BASE_URL) or `permissions.defaultMode`, which must not leak into platform agents.
 *   Project and local settings stay on so CLAUDE.md and repo conventions apply.
 */
export function claudeProfileOptions(profile: ResolvedProfile, baseEnv: Env): Pick<Options, "env" | "settingSources"> {
  const env: Record<string, string | undefined> = { ...baseEnv, ...profile.env };
  if (profile.kind === "cliproxyapi") {
    for (const name of AUTH_ENV) delete env[name];
    env["ANTHROPIC_BASE_URL"] = stripTrailingSlash(profile.baseUrl.href);
    env["ANTHROPIC_AUTH_TOKEN"] = profile.apiKey;
    // Lets Claude Code list the models the proxy exposes (CLIProxyAPI docs).
    env["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1";
  }
  return { env, settingSources: ["project", "local"] };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
