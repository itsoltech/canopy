import { describe, expect, test } from "bun:test";
import { toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { proxyAccount, secretRedactor } from "./management.ts";
import { usageWindowName } from "@canopy/domain/provider-usage";

const observed = "2026-11-14T10:00:00Z";

const account = (signals: Record<string, string>) =>
  proxyAccount({ provider: "codex", quota: { observed_at: observed, signals } });

describe("proxy account observations", () => {
  test("weekly-only Codex plans do not gain a phantom secondary window", () => {
    // CLIProxyAPI's codex.rate_limits fixture: primary=10080, secondary=null.
    // HTTP snapshots can additionally contain a zero secondary watermark without a period or reset.
    for (const duration of [undefined, "", "NaN", "0"]) {
      const parsed = account({
        "X-Codex-Primary-Used-Percent": "48",
        "X-Codex-Primary-Window-Minutes": "10080",
        "X-Codex-Primary-Reset-After-Seconds": "523210",
        "X-Codex-Secondary-Used-Percent": "0",
        ...(duration !== undefined && { "X-Codex-Secondary-Window-Minutes": duration }),
      });

      expect(parsed.windows.map((w) => [w.key, w.usedPercent])).toEqual([["seven_day", 48]]);
      expect(parsed.windows[0]?.resetsAt?.seconds).toBe(1794650400n + 523210n);
    }
  });

  test("duration, not slot order, names daily, weekly, monthly and custom limits", () => {
    for (const [minutes, label] of [
      [300, "5-hour"],
      [1440, "Daily"],
      [10080, "Weekly"],
      [43200, "Monthly"],
      [120, "2-hour"],
    ] as const) {
      const parsed = account({
        "x-codex-secondary-used-percent": "0",
        "x-codex-secondary-window-minutes": String(minutes),
        "x-codex-secondary-reset-at": "2000000000",
      });

      const window = parsed.windows[0]!;
      expect(usageWindowName(window.key, window.windowMinutes)).toBe(label);
      expect(window.usedPercent).toBe(0);
      expect(window.resetsAt?.seconds).toBe(2000000000n);
    }

    expect(account({ "x-codex-primary-used-percent": "25" }).windows[0]?.key).toBe("primary_limit");
    expect(account({ "x-codex-primary-used-percent": "NaN" }).windows).toEqual([]);
  });

  test("Claude drops empty watermarks but retains a real zero or rejection", () => {
    const parsed = account({
      "anthropic-ratelimit-unified-5h-utilization": "0",
      "anthropic-ratelimit-unified-7d-utilization": "0.42",
      "anthropic-ratelimit-unified-7d-reset": "2000000000",
    });

    expect(parsed.windows.map((w) => [w.key, w.usedPercent])).toEqual([["seven_day", 42]]);
    expect(
      account({
        "anthropic-ratelimit-unified-5h-utilization": "0",
        "anthropic-ratelimit-unified-5h-status": "allowed",
      }).windows[0]?.usedPercent,
    ).toBe(0);
    expect(account({ "anthropic-ratelimit-unified-5h-status": "rejected" }).windows[0]?.reached).toBe(true);
  });

  test("only normalized plan names leave the auth-file boundary", () => {
    const parsed = proxyAccount({
      provider: "codex",
      id_token: { plan_type: "plus", chatgpt_account_id: "private-account-id", access_token: "private-token" },
    });

    expect(parsed.plan).toBe(ui.ProxyAccountPlan.PLUS);
    const json = JSON.stringify(toJson(ui.ProxyAccountSchema, parsed));
    expect(json).not.toContain("private-account-id");
    expect(json).not.toContain("private-token");
    expect(proxyAccount({ id_token: "raw.jwt.token" }).plan).toBe(ui.ProxyAccountPlan.UNSPECIFIED);
    expect(proxyAccount({ subscription_type: "max", rate_limit_tier: "default_claude_max_20x" }).plan).toBe(
      ui.ProxyAccountPlan.MAX_20X,
    );
    expect(proxyAccount({ tier: "future-plan" }).plan).toBe(ui.ProxyAccountPlan.OTHER);
    expect(proxyAccount({ plan_type: "fixture-secret" }, Date.now(), secretRedactor(["fixture-secret"])).plan).toBe(
      ui.ProxyAccountPlan.OTHER,
    );
    expect(account({ "x-codex-plan-type": "pro" }).plan).toBe(ui.ProxyAccountPlan.PRO);
  });
});
