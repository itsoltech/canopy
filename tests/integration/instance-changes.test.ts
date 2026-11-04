import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, InstanceStore } from "@canopy/gateway/store";
import { eventually, failure } from "./support/gateway.ts";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";

describe.skipIf(!dockerAvailable)("instance changes at turn boundaries over the gateway↔worker link", () => {
  let f: InstanceFixture;
  beforeAll(async () => {
    f = await startInstanceFixture();
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  for (const harness of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[harness]}: native→proxy→native keeps sessions; running turns keep old env and new work waits`, async () => {
      const name = Provider[harness]!.toLowerCase();
      await f.save(harness, `${name}-old`);
      const first = await f.thread(harness);
      const second = await f.thread(harness);
      const baseline = await f.send(first.id, "baseline");
      expect((await f.finished(first.id, baseline.id)).status).toBe("completed");

      const initial = f
        .records()
        .find((r) => r.harness === name && r.event === "turn" && r.session === first.providerThreadId)!;

      expect(initial.credentialMatches).toBe(true);

      if (harness === Provider.CODEX)
        writeFileSync(join(initial.home, "auth.json"), '{"tokens":{"access_token":"fixture-own-login"}}');
      const held = await f.send(first.id, `HOLD:${name}`);
      await eventually(
        async () => f.records(),
        (rs) =>
          rs.filter((r) => r.harness === name && r.event === "turn" && r.session === first.providerThreadId).length >=
          2,
      );

      const oldTurn = f
        .records()
        .filter((r) => r.harness === name && r.event === "turn")
        .at(-1)!;

      const changed = await f.save(harness, `${name}-proxy`, ProviderProfileKind.CLIPROXYAPI);
      expect(changed.id).toBe("native");
      expect(changed.builtIn).toBe(true);

      if (harness === Provider.CODEX) expect(changed.runtime?.ownLogin).toBe(true);
      const next = await f.send(second.id, "next after switch");
      // A later read-only command crosses the same link while the turn admission is waiting.
      await f.gw.api.listDirectory({ workerId: f.workerId, path: f.dir });
      expect(
        f
          .records()
          .filter((r) => r.harness === name && r.event === "turn")
          .at(-1)!.probe,
      ).toBe(`${name}-old`);
      expect(
        f.records().filter((r) => r.harness === name && r.event === "finish" && r.session === first.providerThreadId),
      ).toHaveLength(1);
      await f.release(name);
      expect((await f.finished(first.id, held.id)).status).toBe("completed");
      expect((await f.finished(second.id, next.id)).status).toBe("completed");

      const newTurn = f
        .records()
        .filter((r) => r.harness === name && r.event === "turn")
        .at(-1)!;

      expect(newTurn).toMatchObject({
        probe: `${name}-proxy`,
        proxy: true,
        credentialMatches: true,
        home: initial.home,
      });
      expect(newTurn.pid).not.toBe(oldTurn.pid);
      const resumed = await f.send(first.id, "resume existing session through proxy");
      expect((await f.finished(first.id, resumed.id)).status).toBe("completed");
      const resumeEvent = { codex: "thread/resume", claude: "resume", grok: "session/load" }[name];
      expect(
        f
          .records()
          .some(
            (r) =>
              r.harness === name &&
              r.event === resumeEvent &&
              r.session === first.providerThreadId &&
              r.probe === `${name}-proxy`,
          ),
      ).toBe(true);
      await f.save(harness, `${name}-back`);
      const back = await f.send(first.id, "back on device login");
      expect((await f.finished(first.id, back.id)).status).toBe("completed");

      const last = f
        .records()
        .filter((r) => r.harness === name && r.event === "turn")
        .at(-1)!;

      expect(last).toMatchObject({
        home: initial.home,
        session: first.providerThreadId,
        proxy: false,
        credentialMatches: true,
        probe: `${name}-back`,
      });

      if (harness === Provider.CODEX) {
        expect(last.provider).toBe("openai");
        expect(readFileSync(join(initial.home, "auth.json"), "utf8")).toContain("fixture-own-login");
        expect(
          f.records().filter((r) => r.harness === name && r.event === "spawn" && r.probe === `${name}-proxy`),
        ).toHaveLength(1);
      }
    }, 40_000);
  }

  test("Codex drains owned background work, restarts once, and leaves other instances untouched", async () => {
    await f.save(Provider.CODEX, "other", ProviderProfileKind.NATIVE, "other", true);
    const other = await f.thread(Provider.CODEX, "other");
    const old = f.records().find((r) => r.harness === "codex" && r.event === "spawn" && r.probe === "other")!;
    const first = await f.thread(Provider.CODEX);
    const started = await f.send(first.id, "BACKGROUND");
    expect((await f.finished(first.id, started.id)).status).toBe("completed");
    const second = await f.thread(Provider.CODEX);
    const heldOne = await f.send(first.id, "HOLD:drain-one");
    const heldTwo = await f.send(second.id, "HOLD:drain-two");
    await eventually(
      async () => f.records(),
      (rs) => rs.some((r) => r.event === "turn" && r.session === second.providerThreadId),
    );
    await f.save(Provider.CODEX, "superseded-config");
    await f.save(Provider.CODEX, "after-background");
    const next = await f.send(first.id, "wait for background drain");
    const separate = await f.send(other.id, "unrelated instance remains usable");
    expect((await f.finished(other.id, separate.id)).status).toBe("completed");
    expect(f.records().some((r) => r.event === "spawn" && r.probe === "after-background")).toBe(false);
    await f.release("drain-one");
    expect((await f.finished(first.id, heldOne.id)).status).toBe("completed");
    expect(f.records().some((r) => r.event === "spawn" && r.probe === "after-background")).toBe(false);
    await f.release("drain-two");
    expect((await f.finished(second.id, heldTwo.id)).status).toBe("completed");
    expect(f.records().some((r) => r.event === "spawn" && r.probe === "after-background")).toBe(false);
    await f.release("background");
    expect((await f.finished(first.id, next.id)).status).toBe("completed");
    expect(f.records().filter((r) => r.event === "spawn" && r.probe === "after-background")).toHaveLength(1);
    expect(f.records().filter((r) => r.event === "spawn" && r.probe === "superseded-config")).toHaveLength(0);
    expect(f.records().filter((r) => r.event === "spawn" && r.probe === "other")).toEqual([old]);
    await f.save(Provider.CODEX, "idle-restart");
    await eventually(
      async () => f.records(),
      (rs) => rs.some((r) => r.event === "spawn" && r.probe === "idle-restart"),
    );
    expect(f.records().filter((r) => r.event === "spawn" && r.probe === "idle-restart")).toHaveLength(1);
  }, 30_000);

  test("switches are owner scoped, revision checked and audited without secret values", async () => {
    const other = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("instance-other@example.test", "Other")),
    );

    const input = create(ui.SaveProviderInstanceRequestSchema, {
      harness: Provider.CODEX,
      id: "native",
      kind: ProviderProfileKind.NATIVE,
    });

    expect(
      await failure(f.gw.runtime.runPromise(InstanceStore.use((s) => s.save({ userId: other, request: input })))),
    ).toContain("not found");

    const current = (await f.gw.api.listProviderInstances({})).instances.find(
      (i) => i.harness === Provider.CODEX && i.id === "native",
    )!;

    expect(
      await failure(f.gw.api.saveProviderInstance({ ...input, expectedRevision: current.revision + 1n })),
    ).toContain("changed meanwhile");

    const audit = await f.query<{ details: object }>(
      "SELECT details FROM audit_log WHERE action='provider.connection_changed'",
    );

    expect(audit).toHaveLength(6);

    const publicData = JSON.stringify([
      toJson(ui.ListProviderInstancesResponseSchema, await f.gw.api.listProviderInstances({})),
      toJson(ui.GetOverviewResponseSchema, await f.gw.api.getOverview({})),
      audit,
      f.logs,
      f.records(),
    ]);

    expect(publicData.includes("fixture-proxy-key")).toBe(false);
    expect(publicData.includes("fixture-secret-")).toBe(false);
    expect(f.records().every((r) => r.credentialMatches)).toBe(true);
  });
});
