import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { failurePresentation } from "@canopy/domain/failure-presentation";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";

describe.skipIf(!dockerAvailable)("Codex connections over the gateway↔worker link", () => {
  let f: InstanceFixture;
  beforeAll(async () => {
    f = await startInstanceFixture();
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  test("a proxy thread resumes after a worker restart with the same instance and provider", async () => {
    await f.save(Provider.CODEX, "proxy", ProviderProfileKind.CLIPROXYAPI);
    const thread = await f.thread(Provider.CODEX);
    const first = await f.send(thread.id, "Cześć");
    expect((await f.finished(thread.id, first.id)).status).toBe("completed");
    await f.restartWorker();
    const resumed = await f.send(thread.id, "Continue");
    expect((await f.finished(thread.id, resumed.id)).status).toBe("completed");
    expect(
      f
        .records()
        .filter((r) => r.event === "turn")
        .map((r) => r.provider),
    ).toEqual(["canopy_native", "canopy_native"]);
    expect(f.records().find((r) => r.event === "thread/resume")?.session).toBe(thread.providerThreadId);
  }, 30_000);

  test("a refused provider switch has a specific explanation and a provider settings action", async () => {
    const thread = await f.thread(Provider.CODEX);
    const sent = await f.send(thread.id, "FAIL:provider-switch");
    const failed = await f.finished(thread.id, sent.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "HARNESS_ERROR", errorClass: "connection_changed" });
    const shown = failurePresentation(failed.error, failed.errorClass, true);
    expect(shown).toMatchObject({
      settings: true,
      model: false,
      proxy: false,
      explanation:
        "Codex could not use this thread with the current connection. Restore its previous connection in provider settings, then retry.",
    });
    const retry = await f.send(thread.id, "Cześć after restoring the connection");
    expect((await f.finished(thread.id, retry.id)).status).toBe("completed");
  }, 30_000);
});
