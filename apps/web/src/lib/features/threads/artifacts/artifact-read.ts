import { ui, type Item } from "@canopy/contracts";
import { isPublishedReply, turnProgress } from "@canopy/domain/work-fold";
import { queries, sharedRead } from "#lib/shared/queries.svelte.ts";
import { threadCache } from "../thread-cache.ts";

const readKey = (id: string) => `ListThreadArtifacts:${id}`;

threadCache.onRelease((id) =>
  queries.forget(id === undefined ? (key) => key.startsWith("ListThreadArtifacts:") : readKey(id)),
);

export function readArtifacts(id: string) {
  return sharedRead(
    readKey(id),
    ui.ListThreadArtifactsResponseSchema,
    `/api/threads/${encodeURIComponent(id)}/artifacts`,
  );
}

function publication(item?: Item) {
  const content = item?.content;

  return content && (isPublishedReply(content) || (content.case === "agentMessage" && content.value.images.length > 0));
}

/** Reconcile against the full index at publication, turn visibility and history replacement boundaries. */
export function invalidateArtifacts(id: string, { change }: ui.ThreadUpdate) {
  let changed = false;

  switch (change.case) {
    case "snapshot":
    case "delta":
      changed = true;
      break;
    case "turn":
      changed = turnProgress(change.value.status) !== "live";
      break;
    case "event": {
      const body = change.value.event?.body;
      changed =
        body?.case === "turnFinished" ||
        ((body?.case === "itemCompleted" || body?.case === "itemStarted") && Boolean(publication(body.value.item)));
      break;
    }

    case "batch":
      changed = change.value.records.some(
        ({ removed, value }) =>
          removed ||
          (value.case === "turn" && turnProgress(value.value.status) !== "live") ||
          (value.case === "item" && publication(value.value.item)),
      );
      break;
  }

  if (changed) queries.invalidate(readKey(id));
}
