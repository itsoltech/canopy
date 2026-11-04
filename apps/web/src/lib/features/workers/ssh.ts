import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { isJsonObject, parseJson, str } from "#lib/shared/json.ts";
import { decode, encode } from "#lib/shared/wire.ts";

export async function workerSsh(
  input: { action: string; target?: string; fingerprint?: string; name?: string; tags?: string[] },
  signal: AbortSignal,
  receive: (event: ui.WorkerSshEvent) => void,
) {
  const response = await fetch("/api/workers/ssh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encode(ui.WorkerSshRequestSchema, create(ui.WorkerSshRequestSchema, input))),
    signal,
  });

  if (!response.ok || !response.body) throw new Error("SSH request failed");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line) continue;
        const message = parseJson(line);

        if (!isJsonObject(message)) throw new Error("SSH request failed");
        const failure = str(message["error"]);

        if (failure) throw new Error(failure);
        const event = message["event"];

        if (event) receive(decode(ui.WorkerSshEventSchema, event));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
