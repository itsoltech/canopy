import { join, resolve } from "node:path";
import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { MessengerStore } from "../../../apps/gateway/src/messengers/store.ts";
import { eventually } from "./gateway.ts";
import type { HarnessBots } from "./harness-bots.ts";

/** Move the same bot to a worker with a separate journal, provider home and session directory. */
export async function secondBotWorker(f: HarnessBots) {
  const { workerId, credential } = await f.gw.addWorker("Bot memory reader");
  const dir = join(f.dir, "reader");
  const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
  const executable = resolve(import.meta.dir, "../fixtures/instance-claude.ts");
  const profileId = "memory-reader";

  const host = new WorkerHost({
    runtime,
    dataDir: dir,
    clientVersion: "test",
    deviceHomes: { claude: join(dir, "claude"), codex: join(dir, "codex"), grok: join(dir, "grok") },
    probe: {
      which: (name) => (name === "claude" ? executable : null),
      version: (path) => (path === executable ? "2.1.316" : undefined),
      realDirectory: (path) => path,
      login: () => "fixture login",
    },
  });

  const link = await openGatewayLink({
    baseUrl: f.gw.grpcUrl,
    credential,
    hello: {
      workerId,
      capabilities: ["bot_harness_v1", "bot_conversations_v1", "bot_web_v1", "bot_workspace_v1"],
      attachmentsRoot: host.attachmentsRoot,
      ...(await runtime.runPromise(journalHello())),
    },
  });

  const serving = serveLink(link, host, runtime);

  const close = async () => {
    await host.close();
    link.close();
    await serving;
    await runtime.dispose();
  };

  try {
    await f.gw.api.saveProviderInstance({
      harness: Provider.CLAUDE,
      kind: ProviderProfileKind.NATIVE,
      create: true,
      id: profileId,
      label: "Bot reader",
      runtime: { binaryPath: executable },
      workerIds: [workerId],
      env: [
        { name: "INSTANCE_TRACE", value: f.trace },
        { name: "BOT_TRACE", value: join(f.dir, "bots.jsonl") },
      ],
    });
    await f.gw.api.setInstanceModels({
      harness: Provider.CLAUDE,
      id: profileId,
      models: { custom: ["fixture-model"] },
    });

    const providerReady = await eventually(
      async () =>
        (await f.gw.api.getOverview({})).workers
          .find((w) => w.id === workerId)
          ?.providerInstances.some((p) => p.id === profileId && p.available),
      Boolean,
    );

    if (!providerReady) throw new Error("The second worker did not report the bot provider");

    return { workerId, profileId, close };
  } catch (cause) {
    await close();
    throw cause;
  }
}

/** Ingest messages through the Slack route so the gateway assigns both conversation and reply audience. */
export async function memoryChannel(f: HarnessBots, botId: string) {
  const { userId } = f.gw;

  const run = <A, E>(use: (store: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
    f.gw.runtime.runPromise(MessengerStore.use(use));

  const account = await run((s) =>
    s.saveAccount(userId, {
      name: "Memory fixture",
      externalId: "TMEMORY",
      appToken: "xapp-fixture",
      botToken: "xoxb-fixture",
    }),
  );

  const lease = (await run((s) => s.claimAccount(userId, account.id, "fixture", new Date())))!;
  await f.query("UPDATE messenger_accounts SET lease_until=now()+interval '1 day' WHERE id=$1", [account.id]);
  const channelId = "CMEMORY";
  const authorId = "UMEMORY";

  const route = await run((s) =>
    s.saveRoute(userId, {
      botId,
      accountId: account.id,
      channelIds: [channelId],
      userIds: [authorId],
      directMessages: false,
      mentions: true,
      observe: false,
      channelContext: false,
      delivery: "reply",
      instructions: "",
    }),
  );

  let sequence = 1000;

  return async (threadId: string, text: string) => {
    const now = new Date();
    const stamp = `${++sequence}.1`;
    await run((s) =>
      s.ingest(
        userId,
        {
          id: stamp,
          accountId: account.id,
          channelId,
          threadId,
          messageId: stamp,
          authorId,
          text,
          timestamp: stamp,
          mention: true,
          direct: false,
        },
        lease,
        now,
      ),
    );
    await run((s) => s.dispatch(userId, new Date(now.getTime() + 4000)));

    const [turn] = await f.query<{ id: string }>(
      "SELECT t.id FROM bot_turns t JOIN bot_channel_conversations c ON c.id=t.conversation_id WHERE c.route_id=$1 AND c.thread_id=$2 ORDER BY t.created_at DESC,t.id DESC LIMIT 1",
      [route.id, threadId],
    );

    if (!turn) throw new Error("Messenger dispatch did not enqueue the bot turn");

    return turn.id;
  };
}
