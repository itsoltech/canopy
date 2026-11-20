import { ui } from "@canopy/contracts";
import { HttpError, requestJson } from "#lib/shared/http.ts";
import { isJsonObject } from "#lib/shared/json.ts";
import { decode } from "#lib/shared/wire.ts";

export type PreviewWindowContext =
  | { state: "connecting" | "offline" | "unavailable" }
  | { state: "ready"; thread: ui.Thread; worker?: ui.Worker; computer?: ui.LinkedComputer };

async function readContext(threadId: string, signal: AbortSignal): Promise<PreviewWindowContext> {
  try {
    const value = await requestJson(
      "GET",
      `/api/threads/${encodeURIComponent(threadId)}/preview`,
      undefined,
      5000,
      signal,
    );

    if (!isJsonObject(value) || !value["thread"]) return { state: "unavailable" };

    return {
      state: "ready",
      thread: decode(ui.ThreadSchema, value["thread"]),
      ...(value["worker"] && { worker: decode(ui.WorkerSchema, value["worker"]) }),
      ...(value["computer"] && { computer: decode(ui.LinkedComputerSchema, value["computer"]) }),
    };
  } catch (cause) {
    return {
      state: cause instanceof HttpError && [403, 404].includes(cause.status) ? "unavailable" : "offline",
    };
  }
}

/** Keep the browser's HTTP/1.1 connections available for preview frames, ACKs and input. */
export function connectPreviewWindow(threadId: string, receive: (context: PreviewWindowContext) => void): () => void {
  const lifetime = new AbortController();
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    if (document.hidden || request || lifetime.signal.aborted) return;
    request = new AbortController();
    const signal = request.signal;
    const result = await readContext(threadId, signal);
    request = undefined;

    if (lifetime.signal.aborted || document.hidden) return;

    if (!signal.aborted) receive(result);
    timer = setTimeout(refresh, signal.aborted ? 0 : 5000);
  };

  const visibility = () => {
    clearTimeout(timer);

    if (document.hidden) request?.abort();
    else void refresh();
  };

  document.addEventListener("visibilitychange", visibility, { signal: lifetime.signal });
  window.addEventListener("online", visibility, { signal: lifetime.signal });
  void refresh();

  return () => {
    lifetime.abort();
    request?.abort();
    clearTimeout(timer);
  };
}
