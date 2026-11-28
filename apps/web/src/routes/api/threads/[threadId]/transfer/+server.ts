import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Moving the thread to another worker (docs/thread-transfers.md): PUT previews, POST starts. */
const Preview = Schema.Struct({ workerId: Schema.String });

const Start = Schema.Struct({
  workerId: Schema.String,
  workspaceId: Schema.String,
  localFiles: Schema.Array(Schema.String),
  confirmedSecrets: Schema.Array(Schema.String),
  expectedHead: Schema.String,
});

export const PUT: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Preview);

  return json(
    encode(
      ui.ThreadTransferPreviewSchema,
      await call((api) => api.previewThreadTransfer({ threadId: params.threadId, workerId: body.workerId })),
    ),
  );
};

export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Start);

  return json(
    encode(
      ui.ThreadTransferSchema,
      await call((api) =>
        api.startThreadTransfer({
          threadId: params.threadId,
          ...body,
          localFiles: [...body.localFiles],
          confirmedSecrets: [...body.confirmedSecrets],
        }),
      ),
    ),
  );
};
