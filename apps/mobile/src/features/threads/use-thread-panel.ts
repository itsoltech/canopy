import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { useAppActive } from "../../ui/active";
import { useForegroundInterval } from "../../ui/interval";

export function useThreadPanel(threadId: string, enabled: boolean) {
  const { client, online, queries } = useSession();
  const active = useAppActive();
  const watching = enabled && !!client && online && active;
  const key = `GetThreadPanel:${threadId}`;
  const read = useSharedQuery(key, () => client!.api.getThreadPanel({ threadId }), watching, 5000);
  useForegroundInterval(() => queries.invalidate(key), 5000, watching);

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
