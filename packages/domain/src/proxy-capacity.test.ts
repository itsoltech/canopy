import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui, ProviderUsageWindowSchema } from "@canopy/contracts";
import { proxyCapacityGlance, proxyCapacityGroups, proxyPlanWeight, supportedProxyAccounts } from "./proxy-capacity.ts";

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

  test("does not guess unverified plan, provider or window multipliers or create absent windows", () => {
    expect(proxyPlanWeight(account("legacy", Plan.MAX_20X, 0))).toEqual({ units: 10, unknown: false });
    expect(proxyPlanWeight(account("legacy", Plan.MAX_20X, 0), "five_hour")).toEqual({ units: 1, unknown: true });
    const codex = create(ui.ProxyAccountSchema, { ...account("codex", Plan.PRO_500, 50), provider: "codex" });
    const grok = create(ui.ProxyAccountSchema, { ...codex, provider: "xai", plan: Plan.ULTRA });

    for (const value of [codex, grok, account("unknown", Plan.OTHER, 50)])
      expect(proxyPlanWeight(value)).toEqual({ units: 1, unknown: true });
    const group = proxyCapacityGroups([codex], now)[0]!;
    expect(group.windows).toHaveLength(1);
    expect(group.windows[0]).toMatchObject({ total: 1, remaining: 0.5, unknown: 1 });
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

    const glance = proxyCapacityGlance(proxies, [], now);
    expect(glance).toHaveLength(1);
    expect(glance[0]?.percent).toBeCloseTo(16.666666);
    expect(
      proxyCapacityGlance(
        proxies.map((p) => ({ ...p, usedBy: [] })),
        [],
        now,
      ),
    ).toEqual([]);
    expect(proxyCapacityGlance(proxies, [{ ...glance[0]!, percent: 95, tone: "danger" }], now)[0]?.percent).toBe(95);
    expect(proxyCapacityGlance(proxies, [{ ...glance[0]!, tone: "extra" }], now)[0]?.tone).toBe("extra");
  });
});
