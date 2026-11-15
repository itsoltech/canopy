import { ui } from "@canopy/contracts";
import { Option, Schema } from "effect";

const Text = Schema.optional(Schema.NullOr(Schema.String));
const Claims = Schema.Struct({ plan_type: Text, chatgpt_plan_type: Text });

/** Read plan names only. A raw JWT is deliberately not decoded or downloaded. */
export const PlanFields = Schema.Struct({
  id_token: Schema.optional(Schema.Unknown),
  plan_type: Text,
  chatgpt_plan_type: Text,
  subscription_type: Text,
  rate_limit_tier: Text,
  tier: Text,
});

const plans = new Map<string, ui.ProxyAccountPlan>([
  ["free", ui.ProxyAccountPlan.FREE],
  ["free-tier", ui.ProxyAccountPlan.FREE],
  ["plus", ui.ProxyAccountPlan.PLUS],
  ["pro", ui.ProxyAccountPlan.PRO],
  ["pro-tier", ui.ProxyAccountPlan.PRO],
  ["pro_100", ui.ProxyAccountPlan.PRO_100],
  ["pro_200", ui.ProxyAccountPlan.PRO_200],
  ["pro_500", ui.ProxyAccountPlan.PRO_500],
  ["premium", ui.ProxyAccountPlan.PREMIUM],
  ["super", ui.ProxyAccountPlan.SUPER],
  ["team", ui.ProxyAccountPlan.TEAM],
  ["business", ui.ProxyAccountPlan.BUSINESS],
  ["enterprise", ui.ProxyAccountPlan.ENTERPRISE],
  ["max", ui.ProxyAccountPlan.MAX],
  ["max_5x", ui.ProxyAccountPlan.MAX_5X],
  ["max_20x", ui.ProxyAccountPlan.MAX_20X],
  ["default_claude_max_5x", ui.ProxyAccountPlan.MAX_5X],
  ["default_claude_max_20x", ui.ProxyAccountPlan.MAX_20X],
  ["ultra", ui.ProxyAccountPlan.ULTRA],
]);

/**
 * OpenAI's own Codex plan identifiers (`X-Codex-Plan-Type`, `chatgpt_plan_type`), reviewed 2026-11-15: `prolite` is
 * Pro 100, `promax` is Pro 500, and plain `pro` is the original $200 Pro plan.
 */
const codexPlans = new Map<string, ui.ProxyAccountPlan>([
  ["pro", ui.ProxyAccountPlan.PRO_200],
  ["prolite", ui.ProxyAccountPlan.PRO_100],
  ["promax", ui.ProxyAccountPlan.PRO_500],
]);

export function proxyAccountPlan(
  provider: string,
  file: typeof PlanFields.Type,
  signals: ReadonlyMap<string, string>,
  redact: (text: string) => string,
): ui.ProxyAccountPlan {
  const claims = Option.getOrUndefined(Schema.decodeUnknownOption(Claims)(file.id_token));
  const codex = provider === "codex";
  // The response header is the freshest Codex reading; stored fields can predate a plan change.
  const header = signals.get("x-codex-plan-type");

  const raw =
    (codex && header) ||
    file.chatgpt_plan_type ||
    file.plan_type ||
    claims?.plan_type ||
    claims?.chatgpt_plan_type ||
    file.rate_limit_tier ||
    file.subscription_type ||
    file.tier ||
    header;

  if (!raw?.trim()) return ui.ProxyAccountPlan.UNSPECIFIED;

  // Only a closed enum leaves this boundary; unknown, hostile and secret-bearing names are never echoed.
  if (redact(raw) !== raw || raw.length > 80) return ui.ProxyAccountPlan.OTHER;
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");

  return (codex ? codexPlans.get(key) : undefined) ?? plans.get(key) ?? ui.ProxyAccountPlan.OTHER;
}
