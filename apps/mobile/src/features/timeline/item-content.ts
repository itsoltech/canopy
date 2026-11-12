import { createContext, useCallback, useContext, useState } from "react";
import type { Item, ui } from "@canopy/contracts";
import type { QueryCache } from "@canopy/domain/shared-query";
import { useSession } from "../../state/session";
import { useTimelineDirectory } from "./directory";

interface LazyContent {
  reference: ui.ThreadSyncContent;
  threadId: string;
  onLoad: (item: Item) => void;
}

export const ItemContent = createContext<LazyContent | undefined>(undefined);
export const useItemContent = () => useContext(ItemContent);

// A pairing owns its completed reads. No timeline subscription or persistent storage.
const contents = new WeakMap<QueryCache, Map<string, Item>>();

function itemCache(session: QueryCache) {
  let cache = contents.get(session);

  if (!cache) {
    cache = new Map<string, Item>();
    contents.set(session, cache);
  }

  return cache;
}

export function useLazyItem(preview: Item) {
  const { queries } = useSession();
  const directory = useTimelineDirectory();
  const reference = directory.content?.(preview.itemId);
  const cache = itemCache(queries);
  const key = JSON.stringify([directory.currentId, reference?.sha256]);
  const [full, setFull] = useState<{ key: string; cache: Map<string, Item>; item: Item }>();

  const onLoad = useCallback(
    (item: Item) => {
      cache.set(key, item);
      setFull({ key, cache, item });
    },
    [cache, key],
  );

  const item = (full?.key === key && full.cache === cache ? full.item : cache.get(key)) ?? preview;

  return {
    item,
    lazy: reference && item === preview ? { reference, threadId: directory.currentId, onLoad } : undefined,
  };
}
