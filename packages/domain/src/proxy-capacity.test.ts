import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui, ProviderUsageWindowSchema } from "@canopy/contracts";
import { proxyCapacityGroups, proxyPlanWeight, supportedProxyAccounts } from "./proxy-capacity.ts";
import { usageSummary, usageSummaryGlance } from "./usage-summary.ts";

const now = 1_800_000_000_000;
const future = timestampFromMs(now + 3_600_000);
const Plan = ui.ProxyAccountPlan;

const account = (id: string, plan: ui.ProxyAccountPlan, percent: number, status = "active") =>
  create(ui.ProxyAccountSchema, {
    id,
    provider: "claude",
    plan,
    status,
    windows: [{ key: "seven_day", usedPercent: percent, resetsAt: future }],
  });

describe("proxy subscription capacity", () => {
  test("combines older standard periods but never combines unknown periods or different custom durations", () => {
    const older = account("older", Plan.PRO, 50);
    const newer = account("newer", Plan.PRO, 0);
    newer.windows[0]!.windowMinutes = 10080;
    expect(proxyCapacityGroups([older, newer], now)[0]?.windows).toMatchObject([{ total: 2, remaining: 1.5 }]);

    const uncertain = create(ui.ProxyAccountSchema, {
      provider: "codex",
      status: "active",
      windows: [
        { key: "primary_limit", usedPercent: 50 },
        { key: "secondary_limit", usedPercent: 80 },
        { key: "duration", windowMinutes: 120, usedPercent: 50 },
        { key: "duration", windowMinutes: 180, usedPercent: 20 },
      ],
    });

    expect(proxyCapacityGroups([uncertain], now)[0]?.windows.map((w) => [w.key, w.windowMinutes, w.total])).toEqual([
      ["duration", 120, 1],
      ["duration", 180, 1],
    ]);
  });
  test("weights measured windows in base-tier units, keeping the denominator independent of usage", () => {
    const groups = proxyCapacityGroups([account("max", Plan.MAX_5X, 50), account("ultra", Plan.ULTRA, 0)], now);
    expect(groups[0]?.windows[0]).toMatchObject({ total: 15, remaining: 12.5, reporting: 2, unknown: 0 });
    expect(groups[0]?.windows[0]?.percentLeft).toBeCloseTo(83.333333);
    expect(groups[0]?.accounts.map((a) => a.id)).toEqual(["max", "ultra"]);
  });

  test("excludes unavailable accounts and missing, expired or nonnumeric window readings", () => {
    const missing = create(ui.ProxyAccountSchema, { ...account("missing", Plan.PRO, 20), windows: [] });

    const expired = create(ui.ProxyAccountSchema, {
      ...account("expired", Plan.PRO, 20),
      windows: [
        create(ProviderUsageWindowSchema, { key: "seven_day", usedPercent: 0, resetsAt: timestampFromMs(now - 1) }),
      ],
    });

    const unavailable = ["disabled", "sign_in", "error", "unknown"].map((status) =>
      account(status, Plan.ULTRA, 0, status),
    );

    const cooling = account("cooling", Plan.MAX_5X, 20, "cooling_down");
    const reached = account("reached", Plan.PRO, 0);
    reached.windows.push(
      ...create(ui.ProxyAccountSchema, { windows: [{ key: "five_hour", reached: true, resetsAt: future }] }).windows,
    );
    const nonnumeric = account("nonnumeric", Plan.ULTRA, Number.NaN);

    const group = proxyCapacityGroups(
      [account("active", Plan.PRO, 20), missing, expired, cooling, reached, nonnumeric, ...unavailable],
      now,
    )[0]!;

    expect(group.excluded).toBe(4);
    expect(group.windows.find((w) => w.key === "seven_day")).toMatchObject({ total: 7, remaining: 0.8, reporting: 3 });
    expect(group.windows.find((w) => w.key === "five_hour")).toMatchObject({ total: 1, remaining: 0, reporting: 1 });
    expect(proxyCapacityGroups([missing], now)[0]?.windows).toEqual([]);
  });

  test("weights Codex plans by OpenAI's stated multipliers and never invents a missing window or plan", () => {
    const codex = (id: string, plan: ui.ProxyAccountPlan, percent: number) =>
      create(ui.ProxyAccountSchema, { ...account(id, plan, percent), provider: "codex" });

    expect(
      [Plan.PLUS, Plan.PRO_100, Plan.PRO_200, Plan.PRO_500].map((plan) => proxyPlanWeight(codex("c", plan, 0)).units),
    ).toEqual([1, 10, 20, 50]);
    // Pro plans have no five-hour limit; a reading there is unverified.
    expect(proxyPlanWeight(codex("c", Plan.PRO_500, 0), "five_hour")).toEqual({ units: 1, unknown: true });
    expect(proxyPlanWeight(account("legacy", Plan.MAX_20X, 0))).toEqual({ units: 10, unknown: false });
    expect(proxyPlanWeight(account("legacy", Plan.MAX_20X, 0), "five_hour")).toEqual({ units: 1, unknown: true });
    const grok = create(ui.ProxyAccountSchema, { ...codex("g", Plan.ULTRA, 0), provider: "xai" });

    for (const value of [grok, account("unknown", Plan.OTHER, 50), account("claude", Plan.UNSPECIFIED, 50)])
      expect(proxyPlanWeight(value)).toEqual({ units: 1, unknown: true });

    const group = proxyCapacityGroups([codex("lite", Plan.PRO_100, 50), codex("max", Plan.PRO_500, 0)], now)[0]!;
    expect(group.windows).toHaveLength(1);
    expect(group.windows[0]).toMatchObject({ total: 60, remaining: 55, unknown: 0 });
  });

  test("filters unsupported identities and combines cached connections into a provider indicator", () => {
    const unsupported = create(ui.ProxyAccountSchema, {
      ...account("hidden", Plan.ULTRA, 100),
      provider: "antigravity",
    });

    expect(supportedProxyAccounts([unsupported])).toEqual([]);
    expect(proxyCapacityGroups([unsupported], now)).toEqual([]);

    const proxy = (id: string, accounts: ui.ProxyAccount[]) =>
      create(ui.ProxySchema, {
        id,
        kind: "cliproxyapi",
        usedBy: ["claude/native"],
        accounts: { state: "ok", accounts },
      });

    const proxies = [
      proxy("one", [account("a", Plan.MAX_5X, 50), unsupported]),
      proxy("two", [account("b", Plan.ULTRA, 0)]),
    ];

    const rows = usageSummary([], proxies, now);
    const glance = usageSummaryGlance(rows, now);
    expect(glance).toHaveLength(1);
    expect(glance[0]?.percent).toBeCloseTo(16.666666);
    // One bar per account across proxies, largest plan first, each filled to what it has left.
    expect(rows[0]?.segments).toEqual([
      { units: 10, percentLeft: 100 },
      { units: 5, percentLeft: 50 },
    ]);
    expect(
      usageSummary(
        [],
        proxies.map((p) => ({ ...p, usedBy: [] })),
        now,
      ),
    ).toEqual([]);
  });
});
