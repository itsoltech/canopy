import { REMOTE_BOTS } from "@canopy/domain/computers";
import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
import { awayReason, computerName } from "#lib/features/computers/computers.ts";

/** The same availability rule for bot lists, chats, details and editors. */
export function useBotHome(node: () => string | undefined) {
  const overview = useOverview();
  const computer = $derived(node() ? overview?.computer(node()!) : undefined);
  const reason = $derived(!node() ? undefined : computer?.status === "connected" && !computer.capabilities.includes(REMOTE_BOTS)
    ? `${computerName(computer)} needs an update for linked bots.` : awayReason(computer));
  return { get reason() { return reason; }, get name() { return computerName(computer); } };
}
