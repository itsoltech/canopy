import { AsyncChannel } from "@canopy/transport";
import type { GatewayCore, CoreRuntime } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";

// Like the thread hub, scoped to the serving core. Notifications contain no content.
const listeners = new WeakMap<CoreRuntime, Map<string, Set<AsyncChannel<boolean>>>>();

export function notifyDraftOwner(runtime: CoreRuntime, owner: string) {
  for (const channel of listeners.get(runtime)?.get(owner) ?? []) if (!channel.queuedItems) channel.push(true);
}

export function notifyDrafts(core: GatewayCore) {
  const { runtime, userId } = core[coreState].options;
  notifyDraftOwner(runtime, userId);
}

export function subscribeDrafts(core: GatewayCore) {
  const { runtime, userId } = core[coreState].options;
  const owners = listeners.get(runtime) ?? new Map<string, Set<AsyncChannel<boolean>>>();
  const channels = owners.get(userId) ?? new Set<AsyncChannel<boolean>>();
  const channel = new AsyncChannel<boolean>();
  channels.add(channel);
  owners.set(userId, channels);
  listeners.set(runtime, owners);

  return {
    channel,
    close: () => {
      channels.delete(channel);
      channel.close();
    },
  };
}
