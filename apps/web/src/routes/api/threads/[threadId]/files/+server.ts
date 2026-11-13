import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call, gateway, failWith } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** A thread's file (docs/protocol.md, "Folder i pliki wątku"): the gateway checks the owner, the worker the roots. */
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Hash = Schema.String.check(Schema.isMaxLength(64));
const TIMEOUT_MS = 35_000;

async function mutate<A>(run: (api: Client<typeof ui.GatewayService>) => Promise<A>): Promise<A> {
  try {
    return await run(gateway());
  } catch (cause) {
    if (cause instanceof ConnectError && cause.code === Code.Aborted)
      error(412, "The file changed on disk. Compare your changes before reloading.");
    failWith(cause);
  }
}

export const GET: RequestHandler = async ({ params, url }) => {
  const path = url.searchParams.get("path") ?? "";
  const itemId = url.searchParams.get("itemId") ?? "";
  const expectedSha256 = url.searchParams.get("expectedSha256") ?? "";

  if (!path || path.length > 4096 || itemId.length > 1024 || expectedSha256.length > 64)
    error(400, "Invalid file path");

  return json(
    encode(
      ui.ThreadFileSchema,
      await call((api) =>
        api.readThreadFile({ threadId: params.threadId, path, itemId, expectedSha256 }, { timeoutMs: TIMEOUT_MS }),
      ),
    ),
  );
};

const Write = Schema.Struct({
  path: Path,
  text: Schema.String,
  expectedSha256: Hash,
  expectedRootIdentity: Schema.optional(Hash),
});

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await readBody(request, Write);
  const content = new TextEncoder().encode(body.text);

  return json(
    encode(
      ui.ThreadFileSchema,
      await mutate((api) =>
        api.writeThreadFile(
          {
            threadId: params.threadId,
            path: body.path,
            content,
            expectedSha256: body.expectedSha256,
            expectedRootIdentity: body.expectedRootIdentity ?? "",
          },
          { timeoutMs: TIMEOUT_MS },
        ),
      ),
    ),
  );
};

const Target = Schema.Struct({ path: Path, expectedSha256: Hash, expectedRootIdentity: Schema.optional(Hash) });

export const DELETE: RequestHandler = async ({ params, request }) => {
  const body = await readBody(request, Target);
  await mutate((api) => api.deleteThreadFile({ threadId: params.threadId, ...body }, { timeoutMs: TIMEOUT_MS }));

  return json({});
};
