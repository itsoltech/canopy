import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ThreadDiffPageSchema } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Target = Schema.Struct({
  snapshotId: Schema.String.check(Schema.isMaxLength(64)),
  path: Schema.String.check(Schema.isMaxLength(4096)),
  offset: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0xffffffff)),
  limit: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
});

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readBody(request, Target);

  const page = await call((api) =>
    api.readThreadDiff({ threadId: params.threadId, ...body }, { signal: request.signal, timeoutMs: 10_000 }),
  );

  return json(encode(ThreadDiffPageSchema, page));
};
