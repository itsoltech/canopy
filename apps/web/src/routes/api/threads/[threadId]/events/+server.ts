import { ui } from "@canopy/contracts";
import { coalesceDeltas } from "#lib/server/coalesce.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";
import { create } from "@bufbuild/protobuf";

/**
 * A bounded recent window, then sequence batches. Reconnects resume the applied checkpoint.
 */
export const GET: RequestHandler = async ({ request, params, url }) => {
  const cursor = (url.searchParams.get("cursor") ?? "").slice(0, 128);
  const parsed = /^range:([a-f0-9-]{36}):(\d{1,20})$/.exec(cursor);
  const seq = parsed && BigInt(parsed[2]!) <= 18446744073709551615n ? parsed : null;

  return sseResponse(
    request,
    async function* (signal) {
      const session = bffSession();
      session.warming.warmer.yieldToNavigation();
      const generation = session.warming.generation;

      const seed =
        !cursor &&
        !url.searchParams.get("from") &&
        !url.searchParams.get("version") &&
        url.searchParams.get("smaller") !== "1"
          ? session.warming.seed(params.threadId)
          : undefined;

      const seededCursor = seed?.change.case === "snapshot" ? seed.change.value.syncCursor : undefined;

      if (seed) yield seed;

      for await (const update of coalesceDeltas(
        session.api.watchThread(
          {
            threadId: params.threadId,
            pageSize: url.searchParams.get("smaller") === "1" ? 8 : 24,
            sequence: true,
            ...(seq && {
              syncCursor: create(ui.ThreadSyncCursorSchema, {
                threadId: params.threadId,
                epoch: seq[1]!,
                appliedSeq: BigInt(seq[2]!),
              }),
            }),
            ...(!seq && seededCursor && { syncCursor: seededCursor }),
            incremental: url.searchParams.get("incremental") === "1",
            cursor: (url.searchParams.get("cursor") ?? "").slice(0, 128),
            fromTurnId: (url.searchParams.get("from") ?? "").slice(0, 128),
            historyVersion: (url.searchParams.get("version") ?? "").slice(0, 128),
          },
          { signal, timeoutMs: 0 },
        ),
      )) {
        session.warming.observe(params.threadId, update, generation);
        yield update;
      }
    },
    (update) => encode(ui.ThreadUpdateSchema, update),
  );
};
