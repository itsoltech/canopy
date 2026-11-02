import type { connectors } from '@open-agents/contracts';
import { listConnectors } from './api.ts';

/** Shared scoped catalog; late responses from a previous bot/thread cannot replace the current one. */
export function useConnectorAccounts(scope: () => { botId: string } | { threadId: string }) {
  const state = $state({ accounts: [] as connectors.ConnectorAccount[], types: [] as connectors.ConnectorType[], loading: true, error: '' });
  $effect(() => {
    const query = new URLSearchParams(scope()).toString();
    let active = true;
    state.accounts = [];
    const load = async () => {
      state.loading = true;
      try {
        const result = await listConnectors(`?${query}`);
        if (active) { state.accounts = result.accounts; state.types = result.types; state.error = ''; }
      } catch { if (active) state.error = 'Could not load connector access.'; }
      finally { if (active) state.loading = false; }
    };
    void load();
    window.addEventListener('connectors-changed', load);
    return () => { active = false; window.removeEventListener('connectors-changed', load); };
  });
  return state;
}
