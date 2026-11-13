const listeners = new Set<() => void>();

import { fromJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

let revision = 0n;
let source: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let retryMs = 2000;

function refresh() {
  clearTimeout(retry);
  source?.close();
  source = undefined;

  if (document.hidden || !listeners.size) return;

  source = new EventSource(`/api/drafts/events?after=${revision}`);
  source.onmessage = (event) => {
    const next = fromJsonString(ui.ComposerDraftChangeSchema, event.data).revision;
    retryMs = 2000;

    if (next === revision) return;
    revision = next;

    for (const listener of listeners) listener();
  };

  source.onerror = () => {
    source?.close();
    source = undefined;
    retry = setTimeout(refresh, retryMs);
    retryMs = Math.min(60_000, retryMs * 2);
  };
}

function foreground() {
  if (!document.hidden) for (const listener of listeners) listener();
  refresh();
}

/** One foreground stream shared by mounted composer hints and the open dialog. */
export function subscribeDraftChanges(listener: () => void) {
  listeners.add(listener);

  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", foreground);
    refresh();
  }

  return () => {
    listeners.delete(listener);

    if (!listeners.size) {
      source?.close();
      clearTimeout(retry);
      source = undefined;
      document.removeEventListener("visibilitychange", foreground);
    }
  };
}
