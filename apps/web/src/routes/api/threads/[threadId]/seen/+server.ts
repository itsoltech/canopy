import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { gateway } from "#lib/server/gateway.ts";
import { SeenMarkers } from "#lib/server/seen-markers.ts";
import type { RequestHandler } from "./$types";

// The latest event the user had on screen (ThreadEvent.seq, decimal: bigint in JSON).
const Body = Schema.Struct({ upToSeq: Schema.String.check(Schema.isPattern(/^\d{1,19}$/)) });

const markers = new SeenMarkers(async (threadId, upToSeq) => {
  await gateway().markThreadSeen({ threadId, upToSeq }, { timeoutMs: 15_000 });
});

/** The thread page saw the thread up to an event (MarkThreadSeen); the overview clears its "unseen" mark everywhere. */
export const POST: RequestHandler = async ({ request, params }) => {
  const { upToSeq } = await readBody(request, Body);
  markers.enqueue(params.threadId, BigInt(upToSeq));

  return json({});
};
