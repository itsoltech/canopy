import type { MessageInitShape } from "@bufbuild/protobuf";
import { ItemStatus, TurnOutcome, ui, type github } from "@canopy/contracts";
import { applyThreadUpdate } from "./thread-snapshot.ts";
import { importPullRequestDraft } from "./github-lifecycle.ts";

interface DraftApi {
  sendMessage(
    request: MessageInitShape<typeof ui.SendMessageRequestSchema>,
    options: { signal: AbortSignal },
  ): Promise<ui.SendMessageResponse>;
  watchThread(
    request: MessageInitShape<typeof ui.WatchThreadRequestSchema>,
    options: { signal: AbortSignal },
  ): AsyncIterable<ui.ThreadUpdate>;
}

/** One explicit user request starts one ordinary thread turn. Never retry a lost send. */
export async function draftPullRequest(
  api: DraftApi,
  threadId: string,
  context: github.PullRequestContextResponse,
  requestId: string,
  signal: AbortSignal,
) {
  const sent = await api.sendMessage(
    {
      threadId,
      text: context.prompt,
      attachmentIds: context.attachment ? [context.attachment.id] : [],
      clientRequestId: requestId,
      delivery: ui.MessageDelivery.QUEUE,
    },
    { signal },
  );

  if (!sent.turn) throw new Error("Draft was not returned. Check the thread before drafting again.");

  return readDraft(api, threadId, sent.turn.id, signal);
}

async function readDraft(api: DraftApi, threadId: string, turnId: string, signal: AbortSignal) {
  let state: ui.ThreadSnapshot | undefined;
  const stop = new AbortController();

  const iterator = api
    .watchThread({ threadId, pageSize: 20 }, { signal: AbortSignal.any([signal, stop.signal]) })
    [Symbol.asyncIterator]();

  try {
    for (;;) {
      const { value: update, done } = await iterator.next();

      if (done) throw new Error("Draft disconnected. Check the thread before drafting again.");
      state = applyThreadUpdate(state, update);
      const turn = state.turns.find((value) => value.id === turnId);
      const change = update.change;

      const finished =
        change.case === "event" &&
        change.value.event?.turnId === turnId &&
        change.value.event.body.case === "turnFinished"
          ? change.value.event.body.value
          : undefined;

      const status = finished ? (finished.outcome === TurnOutcome.COMPLETED ? "completed" : "stopped") : turn?.status;

      if (!status || ["queued", "running"].includes(status)) continue;

      if (status !== "completed") throw new Error("Draft stopped. Check the thread before drafting again.");

      const messages = state.items.flatMap(({ turnId: itemTurn, item }) =>
        itemTurn === turnId && item?.content.case === "agentMessage" && item.status === ItemStatus.COMPLETED
          ? [item.content.value]
          : [],
      );

      const answer = messages.findLast((message) => message.phase === "final_answer") ?? messages.at(-1);

      if (!answer) throw new Error("Draft was not returned. Check the thread before drafting again.");

      return importPullRequestDraft(answer.text);
    }
  } finally {
    // Stop the live read before closing its iterator; otherwise cleanup can await another update.
    stop.abort();
    await iterator.return?.();
  }
}
