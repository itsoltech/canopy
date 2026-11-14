import { create, toBinary } from "@bufbuild/protobuf";
import { MentionKind, ui } from "@canopy/contracts";
import { checkMentions } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/errors.ts";
import { checkedQuotes } from "../core/quotes.ts";
import { AttachmentStore, toUiAttachment } from "../store/attachments.ts";
import { toUiQuote } from "../store/quotes.ts";
import { splitId } from "@canopy/domain/computers";

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const draftTargetKey = (target: ui.ComposerDraftTarget) =>
  JSON.stringify([target.threadId, target.projectId, target.workspaceId, target.parentThreadId]);

export function validateDraft(sql: SqlClient.SqlClient, owner: string, draft: ui.ComposerDraft, remoteTitle?: string) {
  return Effect.gen(function* () {
    const content = draft.content;
    const target = draft.target;

    if (
      !content ||
      !target ||
      !uuid.test(draft.id) ||
      !draft.deviceId ||
      draft.deviceId.length > 200 ||
      !draft.deviceName ||
      draft.deviceName.length > 100 ||
      !content.clientRequestId ||
      content.clientRequestId.length > 200 ||
      content.text.length > 100_000 ||
      (target.threadId && (target.parentThreadId || target.projectId || target.workspaceId)) ||
      toBinary(ui.ComposerDraftSchema, draft).length > 524288
    )
      return yield* Effect.fail(new Invalid("This draft is too large. Shorten it, then retry."));

    // A qualified target was checked at its home before this local transaction.
    const threadId = target.threadId || target.parentThreadId;
    let title = "New thread";

    if (remoteTitle) title = remoteTitle;
    else if (threadId) {
      if (!uuid.test(threadId)) return yield* Effect.fail(new NotFound("Thread not found"));

      const row = (yield* sql<{
        title: string;
        project_id: string;
        workspace_id: string;
      }>`SELECT title,project_id,workspace_id FROM threads
        WHERE id=${threadId}::uuid AND owner_user_id=${owner}::uuid AND deleted_at IS NULL FOR SHARE`)[0];

      if (!row) return yield* Effect.fail(new NotFound("Thread not found"));

      if (target.parentThreadId && (target.projectId !== row.project_id || target.workspaceId !== row.workspace_id))
        return yield* Effect.fail(new NotFound("Workspace not found"));
      title = row.title;
    } else {
      if (!uuid.test(target.projectId) || !uuid.test(target.workspaceId))
        return yield* Effect.fail(new NotFound("Workspace not found"));

      const row = (yield* sql<{
        name: string;
      }>`SELECT p.name FROM projects p JOIN project_workspaces w ON w.project_id=p.id
        WHERE p.id=${target.projectId}::uuid AND w.id=${target.workspaceId}::uuid
        AND p.owner_user_id=${owner}::uuid AND p.archived_at IS NULL FOR SHARE OF p`)[0];

      if (!row) return yield* Effect.fail(new NotFound("Workspace not found"));
      title = `New thread · ${row.name}`;
    }

    const checked = yield* Effect.try({
      try: () => {
        const mentions = checkMentions(content.text, content.mentions);

        return {
          mentions,
          quotes: checkedQuotes(content.quotes, (reason) => new Invalid(reason), content.text, mentions),
        };
      },
      catch: () => new Invalid("Could not save these citations or mentions. Remove them, then retry."),
    });

    for (const quote of checked.quotes) {
      if (!quote.sourceThreadId) continue;

      // Citation references confer no access; their text is owner-provided input.
      if (splitId(quote.sourceThreadId).node) continue;

      if (!uuid.test(quote.sourceThreadId)) return yield* Effect.fail(new NotFound("Citation source not found"));

      const owned =
        yield* sql`SELECT id FROM threads WHERE id=${quote.sourceThreadId}::uuid AND owner_user_id=${owner}::uuid
        UNION ALL SELECT id FROM bots WHERE id=${quote.sourceThreadId}::uuid AND owner_user_id=${owner}::uuid`;

      if (!owned.length) return yield* Effect.fail(new NotFound("Citation source not found"));
    }

    if (content.attachments.length > 20) return yield* Effect.fail(new Invalid("Remove an attachment, then retry."));

    const attachments = yield* (yield* AttachmentStore).forMessage(
      owner,
      content.attachments.map((a) => a.id),
    );

    const ids = new Set(attachments.map((a) => a.id));

    if (checked.mentions.some((m) => m.kind === MentionKind.ATTACHMENT && !ids.has(m.name)))
      return yield* Effect.fail(new Invalid("An attachment is unavailable. Add it again."));

    return create(ui.ComposerDraftSchema, {
      ...draft,
      title,
      takenByDeviceId: "",
      takenByDeviceName: "",
      content: {
        ...content,
        mentions: checked.mentions,
        quotes: checked.quotes.map(toUiQuote),
        attachments: attachments.map(toUiAttachment),
      },
    });
  });
}
