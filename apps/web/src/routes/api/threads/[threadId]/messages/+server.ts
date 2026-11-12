import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { PermissionMode, ui } from "@canopy/contracts";
import { mentionsFromWire } from "#lib/features/mentions/wire.ts";
import { readBody } from "#lib/server/body.ts";
import { gateway, failWith } from "#lib/server/gateway.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  // Empty only with attachments (the gateway checks).
  text: Schema.String.check(Schema.isMaxLength(100_000)),
  clientRequestId: Schema.String.check(Schema.isUUID()),
  // This turn only; missing or "" = the thread's defaults.
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  effort: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  // This turn's permission mode (enum key); missing = the thread's default.
  permissionMode: Schema.optionalKey(Schema.Literals(["ASK", "ACCEPT_EDITS", "READ_ONLY", "FULL_AUTO", "FULL_ACCESS"])),
  // queue (default): the next turn; steer: into the running turn (queued when none runs).
  delivery: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  // Uploaded attachments (api/attachments); a message with attachments is always queued.
  attachmentIds: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isUUID())).check(Schema.isMaxLength(50))),
  // Passages of the thread the message quotes, each with an optional comment (the gateway checks the limits).
  quotes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        text: Schema.String.check(Schema.isMaxLength(20_000)),
        comment: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
        sourceItemId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
        sourceThreadId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
        sourceKind: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
        language: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
        start: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        end: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        sourceAuthor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
        sourceTime: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
      }),
    ).check(Schema.isMaxLength(20)),
  ),
  // Commands, skills, plugins, files and threads in the text (protobuf JSON Mention; the gateway checks them).
  mentions: Schema.optionalKey(Schema.Array(Schema.Json).check(Schema.isMaxLength(50))),
});

export const POST: RequestHandler = async ({ request, params }) => {
  const {
    delivery,
    permissionMode,
    attachmentIds,
    mentions: rawMentions,
    quotes,
    ...body
  } = await readBody(request, Body);

  let mentions;

  try {
    mentions = mentionsFromWire(rawMentions);
  } catch (cause) {
    error(400, cause instanceof Error ? cause.message : "invalid mentions");
  }

  try {
    const response = await gateway().sendMessage(
      {
        threadId: params.threadId,
        ...body,
        attachmentIds: [...(attachmentIds ?? [])],
        mentions,
        quotes: (quotes ?? []).map((quote) => ({ ...quote })),
        ...(permissionMode && { permissionMode: PermissionMode[permissionMode] }),
        delivery: delivery === "steer" ? ui.MessageDelivery.STEER : ui.MessageDelivery.QUEUE,
      },
      { timeoutMs: 10_000 },
    );

    return json(encode(ui.SendMessageResponseSchema, response));
  } catch (cause) {
    const failure = ConnectError.from(cause);

    if (
      [Code.DeadlineExceeded, Code.Unavailable, Code.Canceled, Code.Internal, Code.Unknown].includes(failure.code) ||
      failure.metadata.get("canopy-error-scope") === "computer"
    ) {
      console.warn("Message delivery awaiting confirmation", {
        clientRequestId: body.clientRequestId,
        code: failure.code,
        outcome: "unknown",
      });

      return json({ pending: true }, { status: 202 });
    }

    failWith(cause);
  }
};
