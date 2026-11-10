import { ui } from "@canopy/contracts";
import { isJsonObject, parseJson, str } from "#lib/shared/json.ts";
import { decode, encode } from "#lib/shared/wire.ts";

export async function streamWorkspaceCopy(
  input: ui.CopyWorkspaceRequest,
  signal: AbortSignal,
  receive: (event: ui.WorkspaceCopyProgress) => void,
) {
  const response = await fetch("/api/workspaces/copy", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encode(ui.CopyWorkspaceRequestSchema, input)),
  });

  if (!response.ok || !response.body) throw new Error("Could not start the copy. Check the connection and retry.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let completed = false;

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

        if (!isJsonObject(message)) throw new Error("The copy response was interrupted. Refresh and retry.");
        const error = str(message["error"]);

        if (error) throw new Error(error);

        if (message["event"]) {
          const event = decode(ui.WorkspaceCopyProgressSchema, message["event"]);
          completed ||= event.status === "completed";
          receive(event);
        }
      }
    }

    if (!completed) throw new Error("The copy was interrupted. Refresh the file list and retry.");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
