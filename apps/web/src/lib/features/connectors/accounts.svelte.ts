import type { connectors } from "@canopy/contracts";
import { listConnectors } from "./api.ts";

export interface ConnectorAccounts {
  accounts: connectors.ConnectorAccount[];
  types: connectors.ConnectorType[];
  loading: boolean;
  error: string;
}

/** Shared scoped catalog; late responses from a previous bot/thread cannot replace the current one. */
export function useConnectorAccounts(scope: () => { botId: string } | { threadId: string } | undefined) {
  const state = $state<ConnectorAccounts>({
    accounts: [],
    types: [],
    loading: true,
    error: "",
  });

  $effect(() => {
    const current = scope();

    if (!current) {
      state.accounts = [];
      state.types = [];
      state.loading = false;

      return;
    }

    const query = new URLSearchParams(current).toString();
    let active = true;
    state.accounts = [];

    const load = async () => {
      state.loading = true;

      try {
        const result = await listConnectors(`?${query}`);

        if (active) {
          state.accounts = result.accounts;
          state.types = result.types;
          state.error = "";
        }
      } catch {
        if (active) state.error = "Could not load connector access.";
      } finally {
        if (active) state.loading = false;
      }
    };

    void load();
    window.addEventListener("connectors-changed", load);

    return () => {
      active = false;
      window.removeEventListener("connectors-changed", load);
    };
  });

  return state;
}
