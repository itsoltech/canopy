import { error } from "@sveltejs/kit";
import { gateway, failWith } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";
import { createHash } from "node:crypto";

/** Authenticated BFF download; no public URL, bearer in a URL, or whole-archive heap allocation. */
export const GET: RequestHandler = async ({ params, request }) => {
  if (!/^[a-f0-9-]{36}$/.test(params.id)) error(400, "Choose a log collection");
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const api = gateway();
  let job;

  try {
    job = await api.getDiagnosticsLogsJob({ jobId: params.id }, { signal });
  } catch (cause) {
    failWith(cause);
  }

  if (!job || !["done", "partial"].includes(job.status)) error(409, "Wait for the log collection to finish");
  const expectedBytes = job.bytes;

  const iterator = api
    .downloadDiagnosticsLogs({ jobId: params.id }, { signal, timeoutMs: 180_000 })
    [Symbol.asyncIterator]();

  let sequence = 0;
  let bytes = 0;

  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await iterator.next();

            if (next.done || next.value.sequence !== sequence++) throw new Error("Log download ended early");

            if (next.value.end) {
              if (BigInt(bytes) !== expectedBytes) throw new Error("Log download ended early");
              controller.close();
              abort.abort();

              return;
            }

            bytes += next.value.data.length;

            if (
              next.value.data.length > 32 * 1024 ||
              bytes > 100 * 1024 * 1024 ||
              createHash("sha256").update(next.value.data).digest("hex") !== next.value.checksum
            )
              throw new Error("Invalid log download chunk");
            controller.enqueue(next.value.data);
          } catch {
            abort.abort();
            controller.error(new Error("Could not download logs. Collect logs again."));
          }
        },
        async cancel() {
          abort.abort();
          await iterator.return?.();
        },
      },
      { highWaterMark: 1 },
    ),
    {
      headers: {
        "content-type": "application/zip",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="canopy-diagnostics-${new Date(Number(job.createdAtMs)).toISOString().replace(/[:.]/g, "-")}.zip"`,
      },
    },
  );
};
