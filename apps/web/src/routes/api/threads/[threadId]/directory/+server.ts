import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ThreadDirectoryPageSchema } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Target = Schema.Struct({
  directory: Schema.String.check(Schema.isMaxLength(4096)),
  pageToken: Schema.String.check(Schema.isMaxLength(64)),
  knownRevision: Schema.String.check(Schema.isMaxLength(64)),
  includeIgnored: Schema.Boolean,
  release: Schema.Boolean,
});

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readBody(request, Target);

  const page = await call((api) =>
    api.listThreadDirectory(
      { threadId: params.threadId, pageSize: 100, ...body },
      { signal: request.signal, timeoutMs: 10_000 },
    ),
  );

  return json(encode(ThreadDirectoryPageSchema, page));
};
