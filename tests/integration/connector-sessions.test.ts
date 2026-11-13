import { expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Provider } from "@canopy/contracts";
import { startInstanceFixture } from "./support/instance-fixture.ts";
import { fakeConnector } from "./support/connector.ts";
import { eventually } from "./support/gateway.ts";

for (const [harness, provider] of [
  ["codex", Provider.CODEX],
  ["claude", Provider.CLAUDE],
  ["grok", Provider.GROK],
] as const) {
  test.skipIf(!dockerAvailable)(
    `${harness}: connector grants update existing sessions only at the next turn`,
    async () => {
      const f = await startInstanceFixture();
      const remote = fakeConnector();

      try {
        await f.save(provider, "connectors");
        const thread = await f.thread(provider);
        const first = await f.send(thread.id, "HOLD:connector-add");
        await eventually(
          async () => f.records(),
          (rows) => rows.some((r) => r.harness === harness && r.event === "turn"),
        );

        const account = (
          await f.gw.api.saveConnectorAccount({
            connectorType: "custom",
            name: "canopy",
            url: remote.url,
            authKind: "headers",
            token: remote.secret,
          })
        ).account!;

        const tools = (await f.gw.api.testConnector({ accountId: account.id })).tools;

        const granted = (
          await f.gw.api.setConnectorAccess({
            accountId: account.id,
            expectedRevision: account.revision,
            workerIds: [f.workerId],
          })
        ).account!;

        const panel = () => f.gw.api.getThreadPanel({ threadId: thread.id });
        expect((await panel()).connectors.find((a) => a.accountId === account.id)?.sessionState).toBe("pending");
        expect(f.records().filter((r) => r.harness === harness && r.event === "turn")).toHaveLength(1);
        await f.release("connector-add");
        expect((await f.finished(thread.id, first.id)).status).toBe("completed");

        const second = await f.send(thread.id, "HOLD:connector-remove");

        const active = await eventually(
          async () => f.records().filter((r) => r.harness === harness && r.event === "turn"),
          (rows) => rows.length === 2,
          15_000,
        );

        expect(active).toHaveLength(2);
        const attached = f.records().findLast((r) => r.harness === harness && r.event === "turn")!;
        expect(attached.tools).toEqual(expect.arrayContaining(tools.map((t) => t.name)));
        expect(attached.session).toBe(thread.providerThreadId);
        await eventually(
          panel,
          (p) => p.connectors.find((a) => a.accountId === account.id)?.sessionState === "available",
        );
        await f.gw.api.setConnectorAccess({ accountId: account.id, expectedRevision: granted.revision, workerIds: [] });
        expect((await panel()).connectors.find((a) => a.accountId === account.id)?.sessionState).toBe(
          "pending_removal",
        );
        await f.release("connector-remove");
        expect((await f.finished(thread.id, second.id)).status).toBe("completed");

        const third = await f.send(thread.id, "Connector removed");
        expect((await f.finished(thread.id, third.id)).status).toBe("completed");
        const detached = f.records().findLast((r) => r.harness === harness && r.event === "turn")!;
        expect(detached.session).toBe(thread.providerThreadId);
        expect(detached.tools?.some((name) => tools.some((t) => t.name === name))).toBe(false);
        expect(
          (
            await eventually(
              panel,
              (p) => p.connectors.find((a) => a.accountId === account.id)?.sessionState === "unavailable",
            )
          ).connectors.find((a) => a.accountId === account.id)?.sessionState,
        ).toBe("unavailable");

        const notes = f
          .inputs()
          .filter((i) => i.harness === harness)
          .map((i) => i.parts.map((p) => p.text ?? "").join("\n"));

        expect(notes[0]).not.toContain("is now available");
        expect(notes[1]).toContain("is now available");
        expect(notes[2]).toContain("is no longer available");
        await f.restartWorker();
        const fourth = await f.send(thread.id, "Same catalog after restart");
        expect((await f.finished(thread.id, fourth.id)).status).toBe("completed");
        expect(
          f
            .inputs()
            .filter((i) => i.harness === harness)
            .at(-1)
            ?.parts.map((p) => p.text)
            .join("\n"),
        ).not.toContain("[canopy] Connector");
      } finally {
        await f.close();
        await remote.close();
      }
    },
    90_000,
  );
}
