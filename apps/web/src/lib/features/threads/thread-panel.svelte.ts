import { ui } from "@canopy/contracts";
import { sharedRead, revalidateEvery } from "#lib/shared/queries.svelte.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export function useThreadPanel(threadId: () => string) {
  const read = $derived(
    sharedRead(
      `GetThreadPanel:${threadId()}`,
      ui.ThreadPanelSchema,
      `/api/threads/${encodeURIComponent(threadId())}/panel`,
    ),
  );

  $effect(() => revalidateEvery(read.key, 5000));

  return {
    get data() {
      return read.data;
    },
    get error() {
      return read.snapshot.error ? "Could not load thread details. Try again." : "";
    },
    reload: () => read.reload(),
    grant: async (account: ui.ThreadConnector, granted: boolean) => {
      read.set(
        decode(
          ui.ThreadPanelSchema,
          await requestJson("PUT", `/api/threads/${encodeURIComponent(threadId())}/panel`, {
            accountId: account.accountId,
            granted,
            expectedRevision: account.revision.toString(),
          }),
        ),
      );
    },
  };
}
