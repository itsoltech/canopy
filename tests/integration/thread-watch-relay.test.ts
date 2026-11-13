import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ThreadFileChangeKind as Kind, type ThreadFilesUpdate } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { tempDir } from "@canopy/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("file invalidations through a supported onward route", () => {
  const dir = tempDir("canopy-watch-relay-");
  let home: Awaited<ReturnType<typeof worktreeFixture>>;
  let caller: Awaited<ReturnType<typeof startTestGateway>>;
  let relay: typeof caller;
  const links: LinkedComputers[] = [];

  beforeAll(async () => {
    mkdirSync(join(dir, "home"));
    home = await worktreeFixture(join(dir, "home"), { role: "desktop", capabilities: ["thread_files_watch_v1"] });
    caller = await startTestGateway({ role: "desktop" });
    relay = await startTestGateway({ role: "desktop" });

    for (const gateway of [caller, relay, home.gw]) {
      const link = linkedComputers({
        store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        serve: remoteServe(uiHandlers(gateway.core), gateway.core),
      });

      gateway.core.computers = link;
      gateway.core.network = link.options.network;
      links.push(link);
      await link.start();
    }

    for (const gateway of [caller, home.gw]) {
      const invitation = await relay.api.createComputerPairing({});
      await gateway.api.linkComputer({ address: links[1]!.addresses[0]!, code: invitation.code });
    }

    await eventually(
      async () =>
        links[0]!.reachable().includes(links[1]!.hello().nodeId) &&
        links[2]!.reachable().includes(links[1]!.hello().nodeId),
      Boolean,
    );
    await relay.api.manageComputer({
      action: "share_onward",
      nodeId: links[0]!.hello().nodeId,
      shareOnwardNodeIds: [links[2]!.hello().nodeId],
    });
    await eventually(async () => links[0]!.reachable().includes(links[2]!.hello().nodeId), Boolean);
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled(links.map((link) => link.close()));
    await caller?.close();
    await relay?.close();
    await home?.close();
  }, 30_000);

  test("negotiates watch capability, delivers changes, and releases the home worker watch", async () => {
    const node = links[2]!.hello().nodeId;
    expect(links[0]!.capabilities(node)).toContain("thread_files_watch_v1");
    const thread = await home.tree();
    writeFileSync(join(thread.cwd, "source.txt"), "base");
    const abort = new AbortController();
    const updates: ThreadFilesUpdate[] = [];

    const reading = (async () => {
      for await (const update of caller.api.watchThreadFiles(
        { threadId: qualifyId(thread.id, node), files: ["source.txt"] },
        { signal: abort.signal, timeoutMs: 0 },
      ))
        updates.push(update);
    })().catch((cause: unknown) => {
      if (!abort.signal.aborted) throw cause;
    });

    try {
      await eventually(() => Promise.resolve(updates.length), Boolean);
      expect(updates[0]?.rootIdentity).toMatch(/^[a-f0-9]{64}$/);
      writeFileSync(join(thread.cwd, "source.txt"), "onward change");
      await eventually(
        () =>
          Promise.resolve(
            updates.some((update) =>
              update.changes.some((change) => change.kind === Kind.FILE_CHANGED && change.path === "source.txt"),
            ),
          ),
        Boolean,
      );
    } finally {
      abort.abort();
      await reading;
    }

    await eventually(
      () => Promise.resolve(home.gw.core.link.connections.get(home.workerId)!.fileWatches.size),
      (size) => size === 0,
    );
  });
});
