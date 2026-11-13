import { expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Provider } from "@canopy/contracts";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";
import { fakeConnector } from "./support/connector.ts";
import { eventually } from "./support/gateway.ts";

async function connect(f: InstanceFixture, remote: ReturnType<typeof fakeConnector>) {
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

  return { account: granted, tools };
}

test.skipIf(!dockerAvailable)(
  "Codex attachment failure stays visible and retries the same changed catalog",
  async () => {
    const f = await startInstanceFixture();
    const remote = fakeConnector();

    try {
      await f.save(Provider.CODEX, "connector-failure");
      const thread = await f.thread(Provider.CODEX);
      const baseline = await f.send(thread.id, "Baseline");
      expect((await f.finished(thread.id, baseline.id)).status).toBe("completed");
      const { account, tools } = await connect(f, remote);
      const failed = await f.send(thread.id, "New connector");
      expect((await f.finished(thread.id, failed.id)).status).toBe("failed");
      const panel = () => f.gw.api.getThreadPanel({ threadId: thread.id });
      const rejected = (await panel()).connectors.find((a) => a.accountId === account.id)!;
      expect(rejected.sessionState).toBe("failed");
      expect(rejected.sessionDetail).toContain("Send a new message to retry");
      expect(rejected.sessionAttached).toBe(false);
      await f.release("attach");
      const retry = await f.send(thread.id, "Retry");
      expect((await f.finished(thread.id, retry.id)).status).toBe("completed");
      expect(f.records().findLast((r) => r.harness === "codex" && r.event === "turn")?.tools).toEqual(
        expect.arrayContaining(tools.map((t) => t.name)),
      );
      expect(
        (
          await eventually(
            panel,
            (p) => p.connectors.find((a) => a.accountId === account.id)?.sessionState === "available",
          )
        ).connectors.find((a) => a.accountId === account.id)?.sessionState,
      ).toBe("available");
      await f.gw.api.deleteConnectorAccount({ accountId: account.id });
      expect((await panel()).connectors.find((a) => a.accountId === account.id)?.sessionState).toBe("pending_removal");
      const deleted = await f.send(thread.id, "Account deleted");
      expect((await f.finished(thread.id, deleted.id)).status).toBe("completed");
      expect((await panel()).connectors.some((a) => a.accountId === account.id)).toBe(false);
    } finally {
      await f.close();
      await remote.close();
    }
  },
  90_000,
);

test.skipIf(!dockerAvailable)(
  "Claude refreshes the retained SDK query without losing its background task or session",
  async () => {
    const f = await startInstanceFixture();
    const remote = fakeConnector();

    try {
      await f.save(Provider.CLAUDE, "retained-connectors");
      const thread = await f.thread(Provider.CLAUDE);
      const first = await f.send(thread.id, "CONNECTOR_BACKGROUND");
      expect((await f.finished(thread.id, first.id)).status).toBe("completed");
      const original = f.records().findLast((r) => r.harness === "claude" && r.event === "turn")!;
      const { account, tools } = await connect(f, remote);
      const second = await f.send(thread.id, "Use the new connector");
      expect((await f.finished(thread.id, second.id)).status).toBe("completed");
      const attached = f.records().findLast((r) => r.harness === "claude" && r.event === "turn")!;
      expect(attached.tools).toEqual(expect.arrayContaining(tools.map((t) => t.name)));
      expect(attached.pid).toBe(original.pid);
      expect(attached.session).toBe(original.session);
      await f.gw.api.setConnectorAccess({ accountId: account.id, expectedRevision: account.revision, workerIds: [] });
      const third = await f.send(thread.id, "Connector removed");
      expect((await f.finished(thread.id, third.id)).status).toBe("completed");
      const detached = f.records().findLast((r) => r.harness === "claude" && r.event === "turn")!;
      expect(detached.pid).toBe(original.pid);
      expect(detached.tools?.some((name) => tools.some((t) => t.name === name))).toBe(false);

      const tasks = await f.query<{ status: string }>(
        "SELECT status FROM thread_items WHERE thread_id=$1 AND type='background_task'",
        [thread.id],
      );

      expect(tasks.some((t) => t.status === "in_progress")).toBe(true);
    } finally {
      await f.close();
      await remote.close();
    }
  },
  90_000,
);
