import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { Provider, ProviderProfileKind, ProviderUsageReportSchema, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { failurePresentation } from "@canopy/domain/failure-presentation";
import { noticePresentation } from "@canopy/domain/notice-presentation";
import { usageWarnings, usageFailureHeading } from "@canopy/domain/provider-usage";
import { eventually, watchUntil } from "./support/gateway.ts";
import { startInstanceFixture } from "./support/instance-fixture.ts";
import { usageReset } from "./fixtures/provider-usage.ts";

describe.skipIf(!dockerAvailable)("official harness account limits over WorkerLink", () => {
  let f: Awaited<ReturnType<typeof startInstanceFixture>>;

  const usage = async (provider: Provider) =>
    (await f.gw.api.getOverview({})).workers
      .find((worker) => worker.id === f.workerId)
      ?.providerInstances.find((i) => i.harness === provider && i.id === "native")?.usage;

  beforeAll(async () => {
    f = await startInstanceFixture();
    await f.save(Provider.CODEX, "usage-codex");
    await f.save(Provider.CLAUDE, "usage-claude");
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  test("reads Codex at startup, forwards updates incrementally, persists failures and survives gateway restart", async () => {
    const initial = await eventually(
      () => usage(Provider.CODEX),
      (u) => u?.windows.some((w) => w.usedPercent === 20) ?? false,
    );

    expect(initial?.creditsAvailable).toBe(true);
    expect(initial?.usingExtraUsage).toBeUndefined();
    const thread = await f.thread(Provider.CODEX);
    const abort = new AbortController();
    const updates: ui.OverviewUpdate[] = [];

    const watching = (async () => {
      for await (const update of f.gw.api.watchOverview({}, { signal: abort.signal })) updates.push(update);
    })().catch(() => {});

    try {
      const turn = await f.send(thread.id, "LIMIT:warning");
      expect((await f.finished(thread.id, turn.id)).status).toBe("completed");
      await eventually(
        async () =>
          updates.some(
            (update) =>
              update.change.case === "worker" &&
              update.change.value.providerInstances.some((i) => i.usage?.windows.some((w) => w.usedPercent === 92)),
          ),
        Boolean,
      );
      expect(usageWarnings(await usage(Provider.CODEX)).some((text) => text.includes("Weekly limit 92% used"))).toBe(
        true,
      );
      const failed = await f.send(thread.id, "LIMIT:reached");
      const result = await f.finished(thread.id, failed.id);
      expect(result).toMatchObject({
        status: "failed",
        errorClass: "usage_limit",
        errorCode: `usage_limit:seven_day:${usageReset}`,
      });
      expect(usageFailureHeading(result.errorCode)).toStartWith("Weekly limit reached · resets");
      expect(usageWarnings(await usage(Provider.CODEX))).toContain(
        "Plan limit reached. Further turns may use credits.",
      );

      const rows = await f.query<{ account_key: string; snapshot: object }>(
        "SELECT * FROM provider_usage WHERE worker_id=$1 AND provider=2",
        [f.workerId],
      );

      expect(rows[0]?.account_key).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(rows[0]?.snapshot)).not.toContain("balance");
      await f.disconnect();
      await f.restartGateway();
      expect((await usage(Provider.CODEX))?.windows.some((w) => w.usedPercent === 100)).toBe(true);
    } finally {
      abort.abort();
      await watching;
    }
  }, 60_000);

  test("Claude SDK events preserve the reached window and an explicit paid-usage notice", async () => {
    await f.restartWorker();
    const thread = await f.thread(Provider.CLAUDE);
    const turn = await f.send(thread.id, "LIMIT:credits");
    expect((await f.finished(thread.id, turn.id)).status).toBe("completed");

    const paid = await eventually(
      () => usage(Provider.CLAUDE),
      (u) => u?.usingExtraUsage === true,
    );

    expect(paid?.windows[0]?.usedPercent).toBe(92);
    const updates = await watchUntil(f.gw.api, thread.id, (values) => values.some((v) => v.change.case === "snapshot"));
    const snapshot = updates.find((v) => v.change.case === "snapshot")?.change;
    expect(
      snapshot?.case === "snapshot" &&
        snapshot.value.notices.some(
          (entry) =>
            entry.notice?.code === "extra_usage" &&
            noticePresentation(entry.notice, { recovered: true }).message === "This turn uses extra usage credits.",
        ),
    ).toBe(true);
    const failed = await f.send(thread.id, "LIMIT:reached");
    expect(await f.finished(thread.id, failed.id)).toMatchObject({
      status: "failed",
      errorClass: "usage_limit",
      errorCode: `usage_limit:seven_day:${usageReset}`,
    });

    const settings = (await f.gw.api.listProviderInstances({})).instances.find(
      (i) => i.harness === Provider.CLAUDE && i.id === "native",
    );

    expect(settings?.workers.find((w) => w.workerId === f.workerId)?.usage?.windows[0]?.reached).toBe(true);
  }, 60_000);

  test("rejects obsolete runtime reports and scopes durable reads and writes to the owner", async () => {
    const connection = f.gw.core.link.connections.get(f.workerId)!;
    const current = (await f.gw.api.getOverview({})).workers.find((w) => w.id === f.workerId)!;
    const before = await usage(Provider.CLAUDE);

    const report = create(ProviderUsageReportSchema, {
      provider: Provider.CLAUDE,
      profileId: "native",
      accountKey: "a".repeat(64),
      configVersion: current.configVersion - 1n,
      snapshot: before,
    });

    await f.gw.core.usage.report(connection, report);
    expect(await usage(Provider.CLAUDE)).toEqual(before);

    const foreign = await f.gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("usage-foreign@example.test", "Foreign")),
    );

    await f.query("UPDATE workers SET owner_user_id=$2::uuid WHERE id=$1::uuid", [f.workerId, foreign]);
    expect((await f.gw.core.usage.read()).size).toBe(0);
    report.configVersion = current.configVersion;
    await f.gw.core.usage.report(connection, report);

    const rows = await f.query<{ account_key: string }>(
      "SELECT account_key FROM provider_usage WHERE worker_id=$1 AND provider=1",
      [f.workerId],
    );

    expect(rows[0]?.account_key).not.toBe(report.accountKey);
    await f.query("UPDATE workers SET owner_user_id=$2::uuid WHERE id=$1::uuid", [f.workerId, f.gw.userId]);
  });

  test("an account refresh reads limits again after notifications and a changed runtime starts fresh", async () => {
    const thread = await f.thread(Provider.CODEX);
    const warning = await f.send(thread.id, "LIMIT:warning");
    await f.finished(thread.id, warning.id);
    await eventually(
      () => usage(Provider.CODEX),
      (u) => u?.windows.some((w) => w.usedPercent === 92) ?? false,
    );
    const silent = await f.send(thread.id, "LIMIT:read");
    await f.finished(thread.id, silent.id);
    await f.gw.api.refreshProviders({ workerId: f.workerId, harness: Provider.CODEX, id: "native", accountOnly: true });
    await eventually(
      () => usage(Provider.CODEX),
      (u) => u?.windows.some((w) => w.usedPercent === 75) ?? false,
    );
    await f.save(Provider.CODEX, "usage-new-account");
    await eventually(
      () => usage(Provider.CODEX),
      (u) => u?.windows.some((w) => w.usedPercent === 20) ?? false,
    );
    expect(usageWarnings(await usage(Provider.CODEX))).toEqual([]);
  }, 60_000);

  test("a proxy instance never exposes or stores plan windows, and its limit failure names no plan window", async () => {
    await f.save(Provider.CODEX, "usage-proxy", ProviderProfileKind.CLIPROXYAPI);
    const thread = await f.thread(Provider.CODEX);
    const warning = await f.send(thread.id, "LIMIT:warning");
    await f.finished(thread.id, warning.id);
    const failed = await f.send(thread.id, "LIMIT:reached");
    const result = await f.finished(thread.id, failed.id);

    expect(result).toMatchObject({ status: "failed", errorClass: "usage_limit" });
    expect(result.errorCode).not.toStartWith("usage_limit:");
    expect(usageFailureHeading(result.errorCode)).toBeUndefined();
    expect(failurePresentation(result.error, result.errorClass, true).explanation).toStartWith(
      "The proxy reported a usage limit.",
    );

    // An older worker may still report windows: the gateway drops them for the proxy instance.
    const current = (await f.gw.api.getOverview({})).workers.find((w) => w.id === f.workerId)!;
    await f.gw.core.usage.report(
      f.gw.core.link.connections.get(f.workerId)!,
      create(ProviderUsageReportSchema, {
        provider: Provider.CODEX,
        profileId: "native",
        accountKey: "b".repeat(64),
        configVersion: current.configVersion,
        snapshot: { observedAt: timestampNow(), windows: [{ key: "seven_day", usedPercent: 1 }] },
      }),
    );

    expect(await usage(Provider.CODEX)).toBeUndefined();

    const settings = (await f.gw.api.listProviderInstances({})).instances.find(
      (i) => i.harness === Provider.CODEX && i.id === "native",
    );

    expect(settings?.workers.every((w) => w.usage === undefined)).toBe(true);
    expect(
      await f.query("SELECT 1 FROM provider_usage WHERE worker_id=$1 AND provider=2 AND config_version=$2", [
        f.workerId,
        String(current.configVersion),
      ]),
    ).toEqual([]);
  }, 60_000);
});
