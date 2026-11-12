import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { ComposerConnection } from "@canopy/domain/composer-connection";

export function useComposerConnection(key: string, live: boolean) {
  const connection = useMemo(() => new ComposerConnection(), [key]);
  const available = useSyncExternalStore(connection.subscribe, connection.snapshot);
  useLayoutEffect(() => connection.update(live), [connection, live]);
  useEffect(() => () => connection.reset(), [connection]);

  return { connection, available };
}
