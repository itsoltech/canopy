import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ProviderUsageWindowSchema } from "@canopy/contracts";
import { UsageResets, type UsageResetReading } from "./provider-usage-resets.ts";

const reset = Date.parse("2026-11-28T12:00:00Z");
const minute = 60_000;
const accountKey = "a".repeat(64);
const otherAccount = "b".repeat(64);

function codex(
  observedAt: number,
  usedPercent: number | undefined,
  resetsAt: number | undefined,
  options: Pick<UsageResetReading, "accountKey" | "source" | "passive" | "canConfirm"> = { source: "direct" },
  minutes = 300,
): UsageResetReading {
  return {
    accountKey,
    canConfirm: true,
    ...options,
    observedAt,
    window: create(ProviderUsageWindowSchema, {
      key: minutes === 300 ? "five_hour" : "seven_day",
      windowMinutes: minutes,
      usedPercent,
      resetsAt: resetsAt === undefined ? undefined : timestampFromDate(new Date(resetsAt)),
    }),
  };
}

const exhausted = () => codex(reset - minute, 100, reset);
const renewed = () => codex(reset + minute, 8, reset + 300 * minute);

const key = (account: string, window: string, minutes: number) =>
  `codex:${account}:${window}:${minutes}:${reset / 1000}`;

describe("Codex limit renewal", () => {
  test("requires a newly observed later window with available capacity", () => {
    const detector = new UsageResets("codex", reset - 2 * minute);
    expect(detector.observe([exhausted()], reset - minute)).toEqual([]);
    expect(detector.observe([exhausted()], reset)).toEqual([]);
    expect(detector.observe([codex(reset + 100, 0, reset)], reset + 100)).toEqual([]);
    expect(detector.observe([codex(reset + 200, undefined, reset + 300 * minute)], reset + 200)).toEqual([]);
    expect(detector.observe([codex(reset + 300, 0, undefined)], reset + 300)).toEqual([]);
    expect(
      detector.observe(
        [codex(reset + 400, 0, reset + 300 * minute, { source: "direct", canConfirm: false })],
        reset + 400,
      ),
    ).toEqual([]);
    expect(detector.observe([renewed()], reset + minute)).toEqual([
      { key: key(accountKey, "five-hour", 300), label: "5-hour limit" },
    ]);
    expect(detector.observe([renewed()], reset + 2 * minute)).toEqual([]);
    expect(detector.observe([exhausted()], reset + 2 * minute)).toEqual([]);
    expect(detector.observe([renewed()], reset + 2 * minute)).toEqual([]);
  });

  test("startup cache, reconnect and account changes cannot renew the old reading", () => {
    const cold = new UsageResets("codex", reset - 100);
    expect(cold.observe([exhausted()], reset - 50)).toEqual([]);
    expect(cold.observe([renewed()], reset + minute)).toEqual([]);

    for (const source of ["other-login", "new-link"]) {
      const detector = new UsageResets("codex", reset - 2 * minute);

      detector.observe([exhausted()], reset - minute);
      expect(detector.observe([{ ...renewed(), source }], reset + minute)).toEqual([]);
      // Returning to a former account establishes a fresh baseline.
      expect(detector.observe([renewed()], reset + 2 * minute)).toEqual([]);
    }

    const afterGrace = new UsageResets("codex", reset - 2 * minute);
    afterGrace.observe([exhausted()], reset - minute);
    expect(afterGrace.observe([renewed()], reset + 11 * minute)).toEqual([]);
  });

  test("passive reports need a newer sample and share deduplication with direct reads", () => {
    const detector = new UsageResets("codex", reset - 4 * minute);
    const proxy = { source: "proxy", passive: true, canConfirm: true };
    const other = { source: "other", accountKey: otherAccount };
    const proxyCached = codex(reset - 3 * minute, 100, reset, proxy);

    expect(detector.observe([proxyCached], reset - 3 * minute)).toEqual([]);
    // A newly seen credential may have retained quota from a previous login.
    expect(detector.observe([codex(reset + 5, 0, reset + 300 * minute, proxy)], reset + 5)).toEqual([]);

    const fresh = new UsageResets("codex", reset - 4 * minute);
    fresh.observe([proxyCached], reset - 3 * minute);
    fresh.observe(
      [
        exhausted(),
        codex(reset - minute, 100, reset, proxy),
        codex(reset - minute, 100, reset, other),
        codex(reset - minute, 100, reset, { source: "direct" }, 10080),
      ],
      reset - minute,
    );

    expect(
      fresh
        .observe(
          [
            renewed(),
            codex(reset - minute, 100, reset, proxy),
            codex(reset + minute, 0, reset + 300 * minute, other),
            codex(reset + minute, 0, reset + 10080 * minute, { source: "direct" }, 10080),
          ],
          reset + minute,
        )
        .map((notice) => notice.key),
    ).toEqual([
      key(accountKey, "five-hour", 300),
      key(otherAccount, "five-hour", 300),
      key(accountKey, "seven-day", 10080),
    ]);
    expect(fresh.observe([codex(reset + 2 * minute, 0, reset + 300 * minute, proxy)], reset + 2 * minute)).toEqual([]);
  });
});

test("Claude keeps its existing notice key and accepts an explicit idle zero", () => {
  const detector = new UsageResets("claude", reset - 100);
  const reached = codex(reset - minute, undefined, reset, { source: "claude" }, 10080);

  reached.window.reached = true;
  expect(detector.observe([reached], reset - 100)).toEqual([]);
  expect(detector.observe([reached], reset)).toEqual([]);
  const idle = codex(reset + minute, 0, undefined, { source: "claude" }, 10080);

  expect(detector.observe([idle], reset + minute)).toEqual([
    { key: `claude:seven-day:${reset / 1000}`, label: "Weekly limit" },
  ]);
  expect(detector.observe([idle], reset + 2 * minute)).toEqual([]);
});
