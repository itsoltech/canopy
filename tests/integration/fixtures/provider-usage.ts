import type { JsonObject } from "@canopy/domain";

export const usageReset = 2_000_000_000;

export function codexLimits(percent: number): JsonObject {
  return {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: usageReset },
    secondary: { usedPercent: percent, windowDurationMins: 10080, resetsAt: usageReset },
    credits: { hasCredits: true, unlimited: false, balance: "123" },
    individualLimit: null,
    spendControlReached: null,
    planType: "plus",
    rateLimitReachedType: null,
  };
}

export async function claudeLimits(
  text: string,
  sessionId: string,
  send: (value: JsonObject) => void,
): Promise<boolean> {
  text = (text.split("\n\nCurrent input:\n").at(-1) ?? text).split("\n")[0] ?? text;

  if (!text.startsWith("LIMIT:")) return false;
  const gate = process.env["USAGE_GATE_URL"];

  if (gate) {
    const response = await fetch(gate, { method: "POST", body: text });

    if (!response.ok) throw new Error("usage fixture gate rejected input");
  }

  const rejected = text === "LIMIT:reached";
  send({
    type: "rate_limit_event",
    session_id: sessionId,
    uuid: crypto.randomUUID(),
    rate_limit_info: {
      status: rejected ? "rejected" : "allowed_warning",
      rateLimitType: "seven_day",
      utilization: rejected ? 1 : 0.92,
      resetsAt: usageReset,
      isUsingOverage: text === "LIMIT:credits",
      overageEnabled: true,
    },
  });

  if (text === "LIMIT:credits")
    send({
      type: "system",
      subtype: "notification",
      session_id: sessionId,
      uuid: crypto.randomUUID(),
      key: "usage-transition",
      priority: "high",
      text: "Now using extra usage",
    });

  if (!rejected) return false;
  send({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["You've hit your weekly limit"],
    usage: {},
    session_id: sessionId,
  });

  return true;
}
