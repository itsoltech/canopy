import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { bots, MentionKind } from "@canopy/contracts";
import { checkMentions } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import { SettingsConflict } from "../store/settings.ts";
import { botQuotes } from "./quotes.ts";
import { toUiAttachment } from "../store/attachments.ts";
import type { BotAccess } from "./store-access.ts";
import { botImages } from "./attachments.ts";
import { toUiQuote } from "../store/quotes.ts";

interface Row {
  payload: Uint8Array;
  revision: bigint;
}

/** Bot lock serializes saves and sends. Revision checks preserve edits made on another device. */
export function botDrafts(sql: SqlClient.SqlClient, access: BotAccess) {
  const read = (user: string, id: string) =>
    Effect.gen(function* () {
      yield* access.owned(user, id);

      const row = (yield* sql<Row>`SELECT payload, revision FROM bot_composer_drafts
      WHERE bot_id=${id}::uuid AND owner_user_id=${user}::uuid`)[0];

      return create(bots.BotComposerDraftSchema, {
        ...(row ? fromBinary(bots.BotComposerDraftSchema, row.payload) : create(bots.BotComposerDraftSchema)),
        botId: id,
        revision: BigInt(row?.revision ?? 0),
      });
    });

  return {
    draft: read,
    saveDraft: (user: string, request: bots.SaveBotDraftRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* access.active(user, request.botId, true);
          const previous = yield* read(user, request.botId);

          // A lost save acknowledgement can be retried without creating a false revision conflict.
          if (
            previous.clientRequestId &&
            previous.clientRequestId === request.draft?.clientRequestId &&
            previous.revision === request.expectedRevision + 1n
          )
            return previous;

          if (previous.revision !== request.expectedRevision)
            return yield* Effect.fail(
              new SettingsConflict("This draft changed on another device. Copy your edits, then load the saved draft."),
            );
          const draft = request.draft;

          if (!draft || draft.text.length > 100_000 || draft.clientRequestId.length > 200)
            return yield* Effect.fail(new Invalid("This draft is too long. Shorten the message."));

          const mentions = yield* Effect.try({
            try: () => checkMentions(draft.text, draft.mentions),
            catch: () => new Invalid("Invalid draft mentions"),
          });

          const quotes = yield* botQuotes(sql, user, draft.quotes, draft.text, mentions);

          const images = yield* botImages(
            sql,
            user,
            draft.attachments.map((a) => a.id),
          );

          const ids = new Set(images.map((a) => a.id));

          if (mentions.some((m) => m.kind === MentionKind.ATTACHMENT && !ids.has(m.name)))
            return yield* Effect.fail(new Invalid("This image is unavailable. Upload it again."));

          const saved = create(bots.BotComposerDraftSchema, {
            ...draft,
            botId: request.botId,
            mentions,
            quotes: quotes.map(toUiQuote),
            attachments: images.map(toUiAttachment),
            revision: previous.revision + 1n,
          });

          yield* sql`INSERT INTO bot_composer_drafts(bot_id, owner_user_id, payload, revision)
        VALUES (${request.botId}::uuid, ${user}::uuid, ${toBinary(bots.BotComposerDraftSchema, saved)}, ${saved.revision})
        ON CONFLICT(bot_id) DO UPDATE SET payload=excluded.payload, revision=excluded.revision`;

          return saved;
        }),
      ),
  };
}
