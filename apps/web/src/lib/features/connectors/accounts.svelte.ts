import type { connectors } from "@canopy/contracts";
import { queries, SharedRead } from "#lib/shared/queries.svelte.ts";
import { listConnectors } from "./api.ts";

export interface ConnectorAccounts {
  readonly accounts: connectors.ConnectorAccount[];
  readonly types: connectors.ConnectorType[];
  readonly loading: boolean;
  readonly error: string;
}

const isConnectorRead = (key: string) => key === "ListConnectors" || key.startsWith("ListConnectors:");

/**
 * A bot's or thread's connector access, shared by every component of the tab that shows the same scope (one
 * request). `connectorsChanged` from any device (AppShell) and this tab's "connectors-changed" read it again.
 */
export function useConnectorAccounts(scope: () => { botId: string } | { threadId: string } | undefined) {
  const read = $derived.by(() => {
    const current = scope();

    if (!current) return undefined;
    const query = new URLSearchParams(current).toString();

    return new SharedRead(queries, `ListConnectors:${query}`, () => listConnectors(`?${query}`));
  });

  $effect(() => {
    const changed = () => queries.invalidate(isConnectorRead);
    window.addEventListener("connectors-changed", changed);

    return () => window.removeEventListener("connectors-changed", changed);
  });

  return {
    get accounts() {
      return read?.data?.accounts ?? [];
    },
    get types() {
      return read?.data?.types ?? [];
    },
    get loading() {
      const snapshot = read?.snapshot;

      return !!snapshot && !snapshot.loaded && !snapshot.error;
    },
    get error() {
      return read?.snapshot.error ? "Could not load connector access." : "";
    },
  } satisfies ConnectorAccounts;
}
