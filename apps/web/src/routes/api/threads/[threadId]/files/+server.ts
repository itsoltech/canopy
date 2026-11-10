import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** A thread's file (docs/protocol.md, "Folder i pliki wątku"): the gateway checks the owner, the worker the roots. */
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Hash = Schema.String.check(Schema.isMaxLength(64));
const TIMEOUT_MS = 35_000;

export const GET: RequestHandler = async ({ params, url }) => {
  const path = url.searchParams.get("path") ?? "";

  if (!path || path.length > 4096) error(400, "path is required");

  return json(
    encode(
      ui.ThreadFileSchema,
      await call((api) => api.readThreadFile({ threadId: params.threadId, path }, { timeoutMs: TIMEOUT_MS })),
    ),
  );
};

const Write = Schema.Struct({ path: Path, text: Schema.String, expectedSha256: Hash });

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await readBody(request, Write);
  const content = new TextEncoder().encode(body.text);

  return json(
    encode(
      ui.ThreadFileSchema,
      await call((api) =>
        api.writeThreadFile(
          { threadId: params.threadId, path: body.path, content, expectedSha256: body.expectedSha256 },
          { timeoutMs: TIMEOUT_MS },
        ),
      ),
    ),
  );
};

const Target = Schema.Struct({ path: Path, expectedSha256: Hash });

export const DELETE: RequestHandler = async ({ params, request }) => {
  const body = await readBody(request, Target);
  await call((api) => api.deleteThreadFile({ threadId: params.threadId, ...body }, { timeoutMs: TIMEOUT_MS }));

  return json({});
};
