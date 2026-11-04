import { SharedConfigState, sharedState, type Peers, type SharedHost } from "./shared-context.ts";
import { sharedManagementMethods, type SharedManagementMethods } from "./shared-management.ts";
import { sharedPersistenceMethods, type SharedPersistenceMethods } from "./shared-persistence.ts";
import { sharedSyncMethods, type SharedSyncMethods } from "./shared-sync.ts";
import { sharedValuesMethods, type SharedValuesMethods } from "./shared-values.ts";
import type { ComputerStore } from "./store.ts";

export { type SharedHost } from "./shared-context.ts";

export class SharedConfig {
  declare load: SharedPersistenceMethods["load"];
  declare read: SharedValuesMethods["read"];
  declare scan: SharedSyncMethods["scan"];
  declare push: SharedSyncMethods["push"];
  declare receive: SharedSyncMethods["receive"];
  declare manage: SharedManagementMethods["manage"];
  declare snapshot: SharedManagementMethods["snapshot"];
  declare changed: SharedManagementMethods["changed"];
  declare close: SharedManagementMethods["close"];

  readonly [sharedState] = new SharedConfigState();

  /** Ids of projects shared with linked computers: the same id on every computer. */
  readonly projects = new Set<string>();

  constructor(
    readonly store: ComputerStore,
    readonly host: SharedHost,
    readonly peers: Peers,
  ) {}
}

for (const methods of [sharedPersistenceMethods, sharedValuesMethods, sharedSyncMethods, sharedManagementMethods]) {
  const descriptors = Object.getOwnPropertyDescriptors(methods);

  for (const descriptor of Object.values(descriptors)) descriptor.enumerable = false;
  Object.defineProperties(SharedConfig.prototype, descriptors);
}
