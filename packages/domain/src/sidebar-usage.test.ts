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
    expect(glance.map(({ name, percent, tone }) => ({ name, percent, tone }))).toEqual([
      { name: "Claude", percent: 69, tone: "neutral" },
      { name: "Codex", percent: 94, tone: "danger" },
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
      { name: "Grok", percent: 100, tone: "danger" },
    ]);
  });
});
