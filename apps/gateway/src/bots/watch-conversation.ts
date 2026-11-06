import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";

/** The metadata digest covers mutable cards, reads, streaming text and header config, including linked cards.
 * History uses the durable journal; a matching digest avoids re-sending unchanged control state on reopen. */
export async function* watchConversation(
  read: (cursor?: string) => Promise<bots.BotConversation>,
  linked: () => Promise<bots.BotApproval[]>,
  signal: AbortSignal,
  incremental: boolean,
  cursor: string,
): AsyncGenerator<bots.BotConversation> {
  let revision = "";

  while (!signal.aborted) {
    const snapshot = await read(incremental ? cursor : undefined);
    snapshot.approvals.push(...(await linked()));

    const controls = create(bots.BotConversationSchema, {
      ...snapshot,
      messages: [],
      cursor: "",
      baseCursor: "",
      delta: false,
      removedMessageIds: [],
      historyBeforeSeq: 0n,
      historyHasMore: false,
      historyReset: false,
    });

    const digest = createHash("sha256").update(toBinary(bots.BotConversationSchema, controls)).digest("hex");
    const next = `${snapshot.cursor}:${digest}`;

    if (revision !== next) {
      revision = next;

      if (incremental) {
        snapshot.cursor = next;
        const unchanged = snapshot.delta && cursor.endsWith(`:${digest}`);

        const update = unchanged
          ? create(bots.BotConversationSchema, {
              messages: snapshot.messages,
              cursor: next,
              baseCursor: cursor,
              delta: true,
              removedMessageIds: snapshot.removedMessageIds,
              controlsUnchanged: true,
            })
          : snapshot;

        cursor = next;
        yield update;
      } else yield snapshot;
    }

    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };

      const timer = setTimeout(done, 250);
      signal.addEventListener("abort", done, { once: true });

      if (signal.aborted) done();
    });
  }
}
