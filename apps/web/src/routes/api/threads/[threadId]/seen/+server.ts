import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

// The latest event the user had on screen (ThreadEvent.seq, decimal: bigint in JSON).
const Body = Schema.Struct({ upToSeq: Schema.String.check(Schema.isPattern(/^\d{1,19}$/)) });

/** The thread page saw the thread up to an event (MarkThreadSeen); the overview clears its "unseen" mark everywhere. */
export const POST: RequestHandler = async ({ request, params }) => {
  const { upToSeq } = await readBody(request, Body);
  const response = await call((api) => api.markThreadSeen({ threadId: params.threadId, upToSeq: BigInt(upToSeq) }));

  return json(encode(ui.MarkThreadSeenResponseSchema, response));
};
