import { useEffect } from "react";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";

export function useThreadPanel(threadId: string, enabled: boolean) {
  const { client, online, queries } = useSession();
  const key = `GetThreadPanel:${threadId}`;
  const read = useSharedQuery(key, () => client!.api.getThreadPanel({ threadId }), enabled && !!client, 5000);

  useEffect(() => {
    if (!enabled || !online) return;
    const timer = setInterval(() => queries.invalidate(key), 5000);

    return () => clearInterval(timer);
  }, [enabled, online, queries, key]);

  return {
    ...read,
    grant: async (account: ui.ThreadConnector, granted: boolean) => {
      const panel = await client!.api.setThreadConnectorGrant({
        threadId,
        accountId: account.accountId,
        granted,
        expectedRevision: account.revision,
      });

      queries.set(key, panel);
    },
  };
}
