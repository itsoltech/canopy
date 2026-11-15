import { z } from "zod";
import type { JsonValue } from "@canopy/domain";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

export const MAX_BYTES = 6 * 1024 * 1024;
export const HTTP_TIMEOUT_MS = 300_000;
export const STDIO_TIMEOUT_MS = 60_000;
export const MAX_PENDING = 32;

const RequestId = z.union([z.string().max(256), z.number().int()]);

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: RequestId.optional(),
  method: z.string().max(128),
  params: z.record(z.string(), z.json()).optional(),
});

export const ToolCall = z.object({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.json()).default({}),
});

export const Cancellation = z.object({ requestId: RequestId });

export type Rpc = z.infer<typeof RpcRequest>;

export type RpcId = z.infer<typeof RequestId>;

/** Release the deadline timer and source listeners as soon as a request finishes. */
export function requestDeadline(signals: readonly AbortSignal[], timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, timeoutMs);
  timer.unref();

  for (const source of signals) {
    if (source.aborted) controller.abort();
    else source.addEventListener("abort", cancel, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);

      for (const source of signals) source.removeEventListener("abort", cancel);
    },
  };
}

/** Race even callbacks that do not cooperate with cancellation; always remove the listener. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    signal.throwIfAborted();
  }

  let cancel = () => {};

  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error("Local automation request cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
  });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function readRequest(request: Request, signal: AbortSignal): Promise<Rpc> {
  const reader = request.body?.getReader();

  if (!reader) throw new Error("Missing request body");
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > MAX_BYTES) throw new Error("Request too large");
      chunks.push(chunk.value);
    }

    return RpcRequest.parse(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function failure(id: RpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

export function reply(id: RpcId, result: JsonValue | Pick<ListToolsResult, "tools"> | CallToolResult): Response {
  const json = JSON.stringify({ jsonrpc: "2.0", id, result });

  if (Buffer.byteLength(json) > MAX_BYTES) return failure(id, -32603, "Local automation response too large");

  return new Response(json, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
