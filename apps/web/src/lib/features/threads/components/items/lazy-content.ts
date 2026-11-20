import { getContext, setContext } from "svelte";
import { create, fromBinary, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { loadThreadItem } from "@canopy/domain/thread-content";
import { itemContents } from "../../item-content-cache.ts";

export interface LazyContent {
  reference: ui.ThreadSyncContent;
  threadId: string;
}

const KEY = Symbol("lazy-item-content");

export const provideLazyContent = (content: () => LazyContent | undefined): void => {
  setContext(KEY, content);
};

export const useLazyContent = (): (() => LazyContent | undefined) =>
  getContext<(() => LazyContent | undefined) | undefined>(KEY) ?? (() => undefined);

export function loadItemContent(threadId: string, reference: ui.ThreadSyncContent, signal: AbortSignal) {
  return itemContents.load(threadId, reference, signal, (readSignal) =>
    loadThreadItem(
      reference,
      async (offset, length) => {
        const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/content`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: readSignal,
          body: toJsonString(
            ui.ThreadSyncContentRequestSchema,
            create(ui.ThreadSyncContentRequestSchema, { sha256: reference.sha256, offset, length }),
          ),
        });

        if (!response.ok) throw new Error("Content unavailable");

        return fromBinary(ui.ThreadSyncContentChunkSchema, new Uint8Array(await response.arrayBuffer()));
      },
      readSignal,
      threadId,
    ),
  );
}
