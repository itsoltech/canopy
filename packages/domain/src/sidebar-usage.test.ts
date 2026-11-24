import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import {
  Provider,
  ProviderProfileKind,
  ProviderUsageSnapshotSchema,
  ProviderUsageWindowSchema,
  ui,
} from "@canopy/contracts";
import { sidebarUsageAccounts, sidebarUsageGlance, usageTone } from "./sidebar-usage.ts";
import { usageProxyLimits, usageSummary, usageSummaryGlance, usageSummaryNotes } from "./usage-summary.ts";

const now = 1_800_000_000_000;
const future = timestampFromMs(now + 3_600_000);

const usage = (percent: number, extra = false) =>
  create(ProviderUsageSnapshotSchema, {
    windows: [
      { key: "five_hour", usedPercent: 25, resetsAt: future },
      { key: "seven_day", usedPercent: percent, resetsAt: future },
    ],
    usingExtraUsage: extra,
  });

describe("sidebar usage overview projection", () => {
  test("groups by provider and selects the worst active window across computers without inferring paid use", () => {
    const workers = [
      create(ui.WorkerSchema, {
        id: "a",
        name: "Laptop",
        providerInstances: [
          { id: "native", harness: Provider.CODEX, enabled: true, usage: usage(72) },
          { id: "work", harness: Provider.CLAUDE, enabled: true, usage: usage(69) },
        ],
      }),
      create(ui.WorkerSchema, {
        id: "b",
        name: "Office",
        providerInstances: [
          {
            id: "native",
            harness: Provider.CODEX,
            enabled: true,
            usage: {
              ...usage(94),
              creditsAvailable: true,
              windows: [
                ...usage(94).windows,
                create(ProviderUsageWindowSchema, {
                  key: "seven_day_opus",
                  usedPercent: 100,
                  reached: true,
                  resetsAt: timestampFromMs(now - 1),
                }),
              ],
            },
          },
        ],
      }),
    ];

    const accounts = sidebarUsageAccounts(workers, now);
    const glance = sidebarUsageGlance(accounts, now);
    expect(accounts.map((account) => account.key)).toEqual(["a:2:native", "a:1:work", "b:2:native"]);
    expect(glance.map(({ name, percentLeft, tone }) => ({ name, percentLeft, tone }))).toEqual([
      { name: "Claude", percentLeft: 31, tone: "neutral" },
      { name: "Codex", percentLeft: 6, tone: "danger" },
    ]);
    expect(sidebarUsageAccounts(workers, now + 3_600_000)).toEqual([]);
  });

  test("omits disabled, missing and proxy data while preserving explicit extra usage without percentages", () => {
    const workers = [
      create(ui.WorkerSchema, {
        id: "a",
        providerInstances: [
          {
            id: "proxy",
            harness: Provider.CODEX,
            enabled: true,
            kind: ProviderProfileKind.CLIPROXYAPI,
            usage: usage(100),
          },
          { id: "disabled", harness: Provider.CLAUDE, usage: usage(100) },
          { id: "missing", harness: Provider.GROK, enabled: true },
          { id: "native", harness: Provider.CLAUDE, enabled: true, usage: { usingExtraUsage: true } },
        ],
      }),
    ];

    const accounts = sidebarUsageAccounts(workers, now);
    expect(accounts).toHaveLength(1);
    expect(sidebarUsageGlance(accounts, now)).toMatchObject([
      { name: "Claude", tone: "extra", label: "Claude: extra usage active" },
    ]);
    expect(sidebarUsageAccounts([], now)).toEqual([]);
  });

  test("uses exact warning boundaries and a reached signal without a percentage", () => {
    expect([69.99, 70, 89.99, 90, 100].map((percent) => usageTone(percent))).toEqual([
      "neutral",
      "warning",
      "warning",
      "danger",
      "danger",
    ]);

    const workers = [
      create(ui.WorkerSchema, {
        id: "a",
        providerInstances: [
          {
            id: "native",
            harness: Provider.GROK,
            enabled: true,
            usage: { windows: [{ key: "five_hour", reached: true, resetsAt: future }] },
          },
        ],
      }),
    ];

    expect(sidebarUsageGlance(sidebarUsageAccounts(workers, now), now)).toMatchObject([
      { name: "Grok", percentLeft: 0, tone: "danger" },
    ]);
  });

  test("the summary has one row per provider: lowest reading per window, binding window, readable proxies only", () => {
    const accounts = (state: string) =>
      create(ui.ProxyAccountsSchema, {
        state,
        total: 3,
        accounts: [
          {
            provider: "claude",
            status: "active",
            plan: ui.ProxyAccountPlan.MAX_5X,
            windows: [
              { key: "seven_day", usedPercent: 40, resetsAt: future },
              { key: "five_hour", usedPercent: 95, resetsAt: future },
            ],
          },
          { provider: "claude", status: "active", windows: [{ key: "seven_day", usedPercent: 0, resetsAt: future }] },
          { provider: "grok", status: "disabled" },
        ],
      });

    const proxies = [
      create(ui.ProxySchema, {
        id: "a",
        name: "Team",
        kind: "cliproxyapi",
        usedBy: ["codex/native"],
        accounts: accounts("ok"),
      }),
      create(ui.ProxySchema, { id: "b", name: "Unused", kind: "cliproxyapi", accounts: accounts("ok") }),
      create(ui.ProxySchema, { id: "c", name: "No key", kind: "cliproxyapi", usedBy: ["claude/x"] }),
      create(ui.ProxySchema, {
        id: "d",
        name: "Rejected",
        kind: "cliproxyapi",
        usedBy: ["claude/y"],
        accounts: accounts("unauthorized"),
      }),
      create(ui.ProxySchema, {
        id: "e",
        name: "OpenAI",
        kind: "openai",
        usedBy: ["codex/z"],
        accounts: accounts("ok"),
      }),
    ];

    const rows = usageSummary([], proxies, now);
    expect(usageProxyLimits(proxies, now)).toMatchObject([
      { proxy: { id: "a" }, accounts: [{ provider: "claude" }, { provider: "claude" }] },
    ]);
    expect(usageProxyLimits(proxies, now + 3_600_000)).toEqual([]);

    // Max 5x (5 units, 60% left) + an unknown plan (1 unit, 100% left) = 66.7% weekly; five-hour binds at 5%.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Claude", tone: "danger", word: "Low", binding: { name: "5-hour" } });
    expect(rows[0]?.window?.percentLeft).toBeCloseTo(66.666666);
    expect(rows[0]?.binding?.percentLeft).toBeCloseTo(5);
    expect(usageSummaryGlance(rows, now)[0]?.percentLeft).toBeCloseTo(5);
    expect(usageSummaryGlance(rows, now)[0]?.label).not.toContain("unknown");

    // A direct instance with a lower weekly reading wins that window; the summary keeps one row.
    const workers = [
      create(ui.WorkerSchema, {
        id: "w",
        name: "Studio",
        providerInstances: [{ id: "native", harness: Provider.CLAUDE, enabled: true, usage: usage(90) }],
      }),
    ];

    const mixed = usageSummary(sidebarUsageAccounts(workers, now), proxies, now);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]?.window?.percentLeft).toBe(10);

    expect(usageSummaryNotes(proxies)).toEqual([
      { proxyId: "c", text: "Canopy can’t read accounts from “No key”.", checking: false },
      { proxyId: "d", text: "Canopy can’t read accounts from “Rejected”.", checking: false },
    ]);
  });
});
