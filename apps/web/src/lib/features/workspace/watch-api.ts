import { create } from "@bufbuild/protobuf";
import { ui, ThreadFilesUpdateSchema } from "@canopy/contracts";
import type { WorkspaceFileApi } from "@canopy/domain/workspace-file";
import { decode, encode } from "#lib/shared/wire.ts";
import { parseJson } from "#lib/shared/json.ts";
import { HttpError } from "#lib/shared/http.ts";
import { WorkspaceAccessRevoked } from "@canopy/domain/workspace-file";
import { objectOf } from "@canopy/domain/json";

export const watchFiles: NonNullable<WorkspaceFileApi["watchFiles"]> = async (request, signal, receive) => {
  const response = await fetch(`/api/threads/${encodeURIComponent(request.threadId ?? "")}/files/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(encode(ui.WatchThreadFilesRequestSchema, create(ui.WatchThreadFilesRequestSchema, request))),
  });

  if (!response.ok) throw new HttpError(response.status, "File changes are unavailable");

  if (!response.body) throw new Error("File changes are unavailable");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;
      buffer += value;

      if (buffer.length > 256 * 1024) throw new Error("File changes exceeded the buffer limit");
      let end: number;

      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (event.startsWith("event: failure")) {
          const data = event.split("\n").find((line) => line.startsWith("data: "));
          const code = Number(objectOf(parseJson(data?.slice(6) ?? ""))["code"]);

          if (code === 5 || code === 7 || code === 16)
            throw new WorkspaceAccessRevoked("File access ended. Reopen the thread to check access.");
        }

        if (event.startsWith("event: failure") || event.startsWith("event: away"))
          throw new Error("File changes disconnected");

        if (event.startsWith("data: ")) receive(decode(ThreadFilesUpdateSchema, parseJson(event.slice(6)) ?? null));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
};
