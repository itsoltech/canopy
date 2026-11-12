import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { mentionsFromWire } from "#lib/features/mentions/wire.ts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("edit"),
    text: Schema.String.check(Schema.isMaxLength(100_000)),
    expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    // Mentions in the new text (protobuf JSON Mention; the gateway checks them).
    mentions: Schema.optionalKey(Schema.Array(Schema.Json).check(Schema.isMaxLength(150))),
    // The mentions are the editor's whole set (positions), not a plain-text edit.
    mentionsComplete: Schema.optionalKey(Schema.Boolean),
    quotes: Schema.optionalKey(Schema.Array(Schema.Json).check(Schema.isMaxLength(20))),
    quotesComplete: Schema.optionalKey(Schema.Boolean),
  }),
  // delete: out of the queue; restore: its undo; steer: into the running turn now.
  Schema.Struct({ action: Schema.Literals(["delete", "restore", "steer"]) }),
]);

/** One queued message (docs/ui-api.md, "Kolejka"): edit, delete, restore or steer it. */
export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Body);
  const turnId = params.turnId;

  switch (body.action) {
    case "edit": {
      let mentions;

      try {
        mentions = mentionsFromWire(body.mentions);
      } catch (cause) {
        error(400, cause instanceof Error ? cause.message : "invalid mentions");
      }

      const { text, expectedRevision, mentionsComplete = false, quotesComplete = false } = body;
      const quotes = (body.quotes ?? []).map((quote) => decode(ui.QuoteSchema, quote));

      return json(
        encode(
          ui.EditQueuedTurnResponseSchema,
          await call((api) =>
            api.editQueuedTurn({ turnId, text, expectedRevision, mentions, mentionsComplete, quotes, quotesComplete }),
          ),
        ),
      );
    }

    case "delete":
      return json(encode(ui.DeleteQueuedTurnResponseSchema, await call((api) => api.deleteQueuedTurn({ turnId }))));
    case "restore":
      return json(encode(ui.RestoreQueuedTurnResponseSchema, await call((api) => api.restoreQueuedTurn({ turnId }))));
    case "steer":
      return json(encode(ui.SteerQueuedTurnResponseSchema, await call((api) => api.steerQueuedTurn({ turnId }))));
  }
};
