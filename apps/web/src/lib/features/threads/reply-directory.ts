import { create } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ItemStatus, ui } from "@canopy/contracts";
import { webDrafts } from "#lib/features/drafts/local.svelte.ts";
import { limitsOf } from "#lib/features/attachments/draft.svelte.ts";
import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
import { itemContents } from "./components/items/lazy-content.ts";
import type { ThreadState } from "./thread-state.svelte.ts";

interface Source {
  id: string;
  view: ThreadState;
  readOnly: boolean;
}

/** Historical sources keep their buttons; only the current own answer can send a reply. */
export function replyDirectory(source: () => Source) {
  const settings = useSettings();

  function replySource(turnId: string) {
    const { id, view } = source();

    const entry = view.entries.findLast(
      (entry) => entry.turnId === turnId && !entry.item.parentItemId && entry.item.content.case === "agentMessage",
    );

    const item = entry && (itemContents.get(JSON.stringify([id, entry.contentRef?.sha256])) ?? entry.item);

    return item?.status === ItemStatus.COMPLETED &&
      item.content.case === "agentMessage" &&
      ["", "final_answer"].includes(item.content.value.phase)
      ? { itemId: item.itemId, text: item.content.value.text }
      : undefined;
  }

  return {
    replySource,
    isReplySource: (itemId: string) => {
      const { view } = source();
      const entry = view.entries.find((entry) => entry.id === itemId);

      return Boolean(
        entry &&
        view.turns.some((turn) => turn.id === entry.turnId && turn.status === "completed") &&
        replySource(entry.turnId)?.itemId === itemId,
      );
    },
    canReply: (itemId: string) => {
      const { id, view, readOnly } = source();
      const thread = view.thread;
      const last = view.ownTurns.findLast((turn) => !turn.rewindId);
      const entry = view.ownEntries.find((entry) => entry.id === itemId);

      const draft = webDrafts.get(create(ui.ComposerDraftTargetSchema, { threadId: id }), () =>
        limitsOf(settings?.attachmentLimits),
      );

      const completedAt = entry?.completedAt ?? (last?.completedAt && timestampMs(last.completedAt));
      const hidden = new Set(view.turns.filter((turn) => turn.rewindId).map((turn) => turn.id));

      const newerInput =
        entry &&
        (view.ownEntries.some(
          (row) =>
            !hidden.has(row.turnId) &&
            row.item.content.case === "userMessage" &&
            !row.item.parentItemId &&
            row.firstSeq > entry.firstSeq,
        ) ||
          view.steers.some(
            (steer) =>
              !hidden.has(steer.turnId) &&
              (["pending", "accepted"].includes(steer.status) ||
                (steer.createdAt && completedAt !== undefined && timestampMs(steer.createdAt) >= completedAt)),
          ));

      return Boolean(
        !readOnly &&
        thread?.status === "idle" &&
        thread.runtime === "worker" &&
        thread.import?.mode !== "history" &&
        !thread.rewindPending &&
        view.connection === "live" &&
        !draft.locked &&
        last?.status === "completed" &&
        !last.withdrawn &&
        entry?.turnId === last.id &&
        !newerInput,
      );
    },
    messageSent: (response: ui.SendMessageResponse) => {
      const { view } = source();

      if (response.turn) view.upsertTurn(response.turn);

      if (response.steer) view.upsertSteer(response.steer);
    },
  };
}
