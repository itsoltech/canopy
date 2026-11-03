import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { decode, encode } from "#lib/shared/wire.ts";

export async function workerSsh(input: { action: string; target?: string; fingerprint?: string; name?: string }, signal: AbortSignal, receive: (event: ui.WorkerSshEvent) => void) {
  const response = await fetch("/api/workers/ssh", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(encode(ui.WorkerSshRequestSchema, create(ui.WorkerSshRequestSchema, input))), signal });
  if (!response.ok || !response.body) throw new Error("SSH request failed");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line) as { event?: unknown; error?: string };
        if (message.error) throw new Error(message.error);
        if (message.event) receive(decode(ui.WorkerSshEventSchema, message.event));
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
