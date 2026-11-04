import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson, type JsonBody } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

/** This computer's network access for a settings page: loaded, refreshed while visible (addresses
 * follow the network) and changed through the BFF. Errors stay with the caller's dialog or alert. */
export function useNetworkAccess(refreshMs = 5000) {
  let status = $state.raw(create(ui.NetworkAccessSchema));
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state("");

  async function reload() {
    try {
      status = decode(ui.NetworkAccessSchema, await requestJson("GET", "/api/network"));
      loaded = true;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load network access";
    }
  }

  /** Throws the gateway's message (a busy port, an invalid hostname) to the caller. */
  async function update(action: string, extra: { [key: string]: JsonBody } = {}) {
    busy = true;

    try {
      status = decode(ui.NetworkAccessSchema, await requestJson("PUT", "/api/network", { action, ...extra }));

      return status;
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    void reload();

    const timer = setInterval(() => {
      if (!busy && !document.hidden) void reload();
    }, refreshMs);

    return () => clearInterval(timer);
  });

  return {
    get status() {
      return status;
    },
    get loaded() {
      return loaded;
    },
    get busy() {
      return busy;
    },
    get error() {
      return error;
    },
    reload,
    update,
  };
}

export type NetworkAccessState = ReturnType<typeof useNetworkAccess>;
