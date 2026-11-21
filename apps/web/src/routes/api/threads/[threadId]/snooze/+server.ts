import { fromJson } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({ snoozed: Schema.Boolean, snoozedUntil: Schema.optional(Schema.String) });

function deadline(value: string | undefined) {
  if (value === undefined) return undefined;

  try {
    return fromJson(TimestampSchema, value);
  } catch {
    error(400, "Choose a valid date and time.");
  }
}

export const POST: RequestHandler = async ({ request, params }) => {
  const { snoozed, snoozedUntil } = await readBody(request, Body);
  const until = deadline(snoozedUntil);
  const result = await call((api) => api.setThreadSnooze({ threadId: params.threadId, snoozed, snoozedUntil: until }));

  return json(encode(ui.GetThreadResponseSchema, result));
};
