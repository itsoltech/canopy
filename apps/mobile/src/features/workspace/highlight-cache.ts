import { toBinary } from "@bufbuild/protobuf";
import { ThreadFileHighlightSchema, type ThreadFileHighlight } from "@canopy/contracts";
import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import type { routedMobileClient } from "../../api/routes";

type HighlightClient = ReturnType<typeof routedMobileClient>;

const caches = new WeakMap<HighlightClient, Map<string, { value: ThreadFileHighlight; bytes: number }>>();
const identities = new WeakMap<WorkspaceFile, number>();

export const clearHighlights = (client: HighlightClient): void => {
  caches.delete(client);
};

let serial = 0;

export function highlightKey(document: WorkspaceFile, start: number, draft: boolean): string {
  let id = identities.get(document);

  if (id === undefined) identities.set(document, (id = ++serial));

  return `${id}:${document.file?.sha256}:${draft ? document.draftRevision : "saved"}:${start}`;
}

/** Pairing-client-scoped LRU. Keys never retain documents, sources, drafts or credentials. */
export function cachedHighlight(client: HighlightClient, key: string): ThreadFileHighlight | undefined {
  const cache = caches.get(client);
  const entry = cache?.get(key);

  if (entry && cache) {
    cache.delete(key);
    cache.set(key, entry);
  }

  return entry?.value;
}

export function rememberHighlight(client: HighlightClient, key: string, value: ThreadFileHighlight): void {
  let cache = caches.get(client);

  if (!cache) caches.set(client, (cache = new Map()));
  cache.delete(key);
  cache.set(key, { value, bytes: toBinary(ThreadFileHighlightSchema, value).byteLength });
  let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);

  while (cache.size > 128 || bytes > 2 * 1024 * 1024) {
    const first = cache.entries().next().value;

    if (!first) break;
    cache.delete(first[0]);
    bytes -= first[1].bytes;
  }
}
