import { describe, expect, test } from "bun:test";
import { toJson } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { proxyAccount, proxyAccountsOf, secretRedactor } from "./management.ts";
import { usageWindowName, usageReset } from "@canopy/domain/provider-usage";

const observed = "2026-11-14T10:00:00Z";
const now = Date.parse(observed);

const account = (signals: Record<string, string>) =>
  proxyAccount({ provider: "codex", quota: { observed_at: observed, signals } }, now);

describe("proxy account observations", () => {
  test("model observations decode independently and choose a complete latest reading per window", () => {
    const quota = (observed_at: string, utilization: string, reset: string) => ({
      observed_at,
      signals: {
        "Anthropic-Ratelimit-Unified-7d-Utilization": utilization,
        "Anthropic-Ratelimit-Unified-7d-Reset": reset,
      },
    });

    const parsed = proxyAccountsOf(
      [
        {
          provider: "claude",
          quota: {
            ...quota("2026-11-14T09:00:00Z", "0.55", "1794823200"),
            signals: {
              ...quota("", "0.55", "1794823200").signals,
              "anthropic-ratelimit-unified-5h-utilization": "0.22",
              "anthropic-ratelimit-unified-5h-reset": "1794661200",
            },
          },
          model_quotas: {
            opus: quota(observed, "0.83", "1794909600"),
            older: quota("2026-11-14T08:00:00Z", "0.95", "1794823200"),
            malformed: { signals: { invalid: 123 } },
            missing: null,
          },
        },
      ],
      now,
    );

    expect(parsed).toHaveLength(1);
    expect(
      parsed[0]?.windows.map((window) => [
        window.key,
        window.usedPercent,
        window.resetsAt?.seconds,
        window.observedAt && timestampDate(window.observedAt).toISOString(),
      ]),
    ).toEqual([
      ["seven_day", 83, 1794909600n, "2026-11-14T10:00:00.000Z"],
      ["five_hour", 22, 1794661200n, "2026-11-14T09:00:00.000Z"],
    ]);

    // A later reset or manual refill must be able to lower usage, including all the way to zero.
    const reset = proxyAccount({
      quota: quota(observed, "0", "1795255200"),
      model_quotas: { older: quota("2026-11-14T09:00:00Z", "0.95", "1794823200") },
    });

    expect(reset.windows[0]?.usedPercent).toBe(0);
    expect(reset.windows[0]?.resetsAt?.seconds).toBe(1795255200n);

    for (const entries of [
      [quota("", "0.55", "1794823200"), quota("", "0.83", "1794823200")],
      [quota(observed, "0.55", "1794823200"), quota(observed, "0.83", "1794823200")],
    ]) {
      for (const order of [entries, entries.toReversed()]) {
        const account = proxyAccount({ model_quotas: Object.fromEntries(order.map((value, index) => [index, value])) });

        expect(account.windows[0]?.usedPercent).toBe(83);
        expect(account.windows[0]?.observedAt?.seconds).toBe(entries[0]?.observed_at ? BigInt(now / 1000) : undefined);
      }
    }
  });

  test("Codex epochs, relative seconds and Claude epochs resolve to realistic reset times", () => {
    const codex = account({
      "x-codex-primary-used-percent": "47",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1794823200",
      "x-codex-secondary-used-percent": "19",
      "x-codex-secondary-window-minutes": "300",
      "x-codex-secondary-reset-after-seconds": "10800",
    });

    const claude = account({
      "anthropic-ratelimit-unified-5h-utilization": "0.19",
      "anthropic-ratelimit-unified-5h-reset": "1794661200",
      "anthropic-ratelimit-unified-7d-utilization": "0.47",
      "anthropic-ratelimit-unified-7d-reset": "1794823200",
    });

    expect(codex.windows.map((w) => [w.resetsAt?.seconds, usageReset(w, true, now)])).toEqual([
      [1794823200n, "Resets in 2 d 0 h"],
      [1794661200n, "Resets in 3 h"],
    ]);
    expect(codex.windows.map((w) => w.observedAt?.seconds)).toEqual([BigInt(now / 1000), undefined]);
    expect(claude.windows.map((w) => [w.resetsAt?.seconds, usageReset(w, true, now)])).toEqual([
      [1794661200n, "Resets in 3 h"],
      [1794823200n, "Resets in 2 d 0 h"],
    ]);
  });

  test("implausible resets are unknown, including millisecond epochs and the old review fixture", () => {
    for (const reset of ["4070908800", "1794661200000", String(now / 1000 + 401 * 86400)]) {
      expect(
        account({ "x-codex-primary-used-percent": "47", "x-codex-primary-reset-at": reset }).windows[0]?.resetsAt,
      ).toBeUndefined();
      expect(
        account({ "anthropic-ratelimit-unified-7d-utilization": "0.47", "anthropic-ratelimit-unified-7d-reset": reset })
          .windows[0]?.resetsAt,
      ).toBeUndefined();
    }

    expect(
      account({ "x-codex-primary-used-percent": "47", "x-codex-primary-reset-after-seconds": String(401 * 86400) })
        .windows[0]?.resetsAt,
    ).toBeUndefined();

    const boundary = account({
      "x-codex-primary-used-percent": "47",
      "x-codex-primary-reset-after-seconds": String(400 * 86400),
    }).windows[0]!;

    expect(boundary.resetsAt).toBeDefined();

    const cached = { ...boundary, resetsAt: { ...boundary.resetsAt!, seconds: 4070908800n } };

    expect(usageReset(cached, true, now)).toBe("");
    expect(usageReset(cached, false, now)).toBe("");
  });

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
        "x-codex-secondary-reset-at": "1794661200",
      });

      const window = parsed.windows[0]!;
      expect(usageWindowName(window.key, window.windowMinutes)).toBe(label);
      expect(window.usedPercent).toBe(0);
      expect(window.resetsAt?.seconds).toBe(1794661200n);
    }

    expect(account({ "x-codex-primary-used-percent": "25" }).windows[0]?.key).toBe("primary_limit");
    expect(account({ "x-codex-primary-used-percent": "NaN" }).windows).toEqual([]);
  });

  test("Claude drops empty watermarks but retains a real zero or rejection", () => {
    const parsed = account({
      "anthropic-ratelimit-unified-5h-utilization": "0",
      "anthropic-ratelimit-unified-7d-utilization": "0.42",
      "anthropic-ratelimit-unified-7d-reset": "1794823200",
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
    expect(account({ "x-codex-plan-type": "pro" }).plan).toBe(ui.ProxyAccountPlan.PRO_200);
    expect(proxyAccount({ id_token: { plan_type: "pro_100" } }).plan).toBe(ui.ProxyAccountPlan.PRO_100);
    expect(proxyAccount({ chatgpt_plan_type: "Pro 500" }).plan).toBe(ui.ProxyAccountPlan.PRO_500);
    expect(proxyAccount({ subscription_type: "super" }).plan).toBe(ui.ProxyAccountPlan.SUPER);
  });
});
