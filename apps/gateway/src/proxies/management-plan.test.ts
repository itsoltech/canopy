import { describe, expect, test } from "bun:test";
import { toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { proxyCapacityGroups } from "@canopy/domain/proxy-capacity";
import { proxyAccountsOf, secretRedactor } from "./management.ts";

const observed = "2026-11-15T10:00:00Z";
const now = Date.parse(observed);
const Plan = ui.ProxyAccountPlan;

/** Extra fields a proxy can add: a stale claim, or a fork's own (and possibly malformed) multiplier. */
interface Extra {
  id_token?: { plan_type: string; chatgpt_account_id: string };
  capacity?: string | { value: number; plan?: string | { nested: boolean }; source?: string | number };
}

/** Shapes of a real `GET /v0/management/auth-files` listing; every value here is fake. */
const codex = (index: string, plan: string, used: string, extra: Extra = {}) => ({
  id: `codex-${index}.json`,
  auth_index: index,
  name: `codex-${index}.json`,
  type: "codex",
  provider: "codex",
  email: `person-${index}@example.test`,
  account_type: "oauth",
  account: `person-${index}@example.test`,
  status: "active",
  disabled: false,
  unavailable: false,
  priority: 0,
  weight: 1,
  quota: {
    observed_at: observed,
    signals: {
      "X-Codex-Plan-Type": plan,
      "X-Codex-Primary-Used-Percent": used,
      "X-Codex-Primary-Window-Minutes": "10080",
      "X-Codex-Primary-Reset-After-Seconds": "86400",
      "X-Codex-Active-Limit": "codex",
    },
  },
  ...extra,
});

const claude = (index: string, used: string, extra: Extra = {}) => ({
  id: `claude-${index}.json`,
  auth_index: index,
  name: `claude-${index}.json`,
  type: "claude",
  provider: "claude",
  email: `person-${index}@example.test`,
  account_type: "oauth",
  status: "active",
  quota: {
    observed_at: observed,
    signals: {
      "Anthropic-Ratelimit-Unified-7d-Utilization": used,
      "Anthropic-Ratelimit-Unified-7d-Reset": "1795255200",
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.1",
      "Anthropic-Ratelimit-Unified-5h-Reset": "1794744000",
      "Anthropic-Ratelimit-Unified-Status": "allowed",
    },
  },
  model_quotas: {
    "claude-opus-fake": { observed_at: observed, signals: { "Anthropic-Ratelimit-Unified-7d-Utilization": used } },
  },
  ...extra,
});

describe("auth-file plans", () => {
  test("Codex plans come from OpenAI's plan header, fresher than a stored claim", () => {
    const accounts = proxyAccountsOf(
      [
        codex("1", "prolite", "50"),
        codex("2", "promax", "0", { id_token: { plan_type: "pro", chatgpt_account_id: "fake-account-id" } }),
        codex("3", "pro", "10"),
        codex("4", "plus", "100"),
        codex("5", "Pro Lite", "0"),
        codex("6", "future_plan", "0"),
      ],
      now,
    );

    expect(accounts.map((a) => a.plan)).toEqual([
      Plan.PRO_100,
      Plan.PRO_500,
      Plan.PRO_200,
      Plan.PLUS,
      Plan.OTHER,
      Plan.OTHER,
    ]);
    expect(JSON.stringify(accounts.map((a) => toJson(ui.ProxyAccountSchema, a)))).not.toContain("fake-account-id");

    // Pro 100 (10 units, half used) + Pro 500 (50 units, unused) = 55 of 60 weekly units.
    const weekly = proxyCapacityGroups(accounts.slice(0, 2), now)[0]?.windows[0];
    expect(weekly).toMatchObject({ key: "seven_day", total: 60, remaining: 55, unknown: 0 });
  });

  test("a Claude listing has no plan identifier; its plan stays unknown and counts as 1", () => {
    const accounts = proxyAccountsOf([claude("7", "0.5"), claude("8", "0")], now);

    expect(accounts.map((a) => a.plan)).toEqual([Plan.UNSPECIFIED, Plan.UNSPECIFIED]);
    expect(accounts[0]?.windows.map((w) => [w.key, w.usedPercent])).toEqual([
      ["five_hour", 10],
      ["seven_day", 50],
    ]);
    expect(proxyCapacityGroups(accounts, now)[0]?.windows.find((w) => w.key === "seven_day")).toMatchObject({
      total: 2,
      remaining: 1.5,
      unknown: 2,
    });
  });

  test("a proxy's own extra fields, valid or malformed, neither change the plan nor drop the account", () => {
    const accounts = proxyAccountsOf(
      [
        claude("9", "0.2", { capacity: { value: 5, plan: "default_claude_max_5x", source: "plan" } }),
        claude("10", "0.2", { capacity: "lots" }),
        claude("11", "0.2", { capacity: { value: -1, plan: { nested: true }, source: 7 } }),
        codex("12", "prolite", "0", { capacity: { value: 999_999, source: "manual" } }),
      ],
      now,
    );

    expect(accounts.map((a) => a.plan)).toEqual([Plan.UNSPECIFIED, Plan.UNSPECIFIED, Plan.UNSPECIFIED, Plan.PRO_100]);
    expect(proxyCapacityGroups(accounts, now).map((g) => g.windows[0]?.total)).toEqual([3, 10]);
  });

  test("an API-key credential never shows its key as the account label", () => {
    const key = "fake-upstream-key-0123456789";

    const [account] = proxyAccountsOf(
      [{ id: "claude-key", provider: "claude", account_type: "api_key", account: key, label: "Team key" }],
      now,
      secretRedactor([]),
    );

    expect(account?.label).toBe("Team key");
    expect(JSON.stringify(toJson(ui.ProxyAccountSchema, account!))).not.toContain(key);
  });
});
