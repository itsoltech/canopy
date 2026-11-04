import { create } from "@bufbuild/protobuf";
import { onMount } from "svelte";
import { ui } from "@canopy/contracts";
import { requestJson, type JsonBody } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { useConnectionRequest } from "./connection-request.svelte.ts";

/** This computer's network access for a settings page: loaded, refreshed while visible (addresses
 * follow the network) and changed through the BFF. Errors stay with the caller's dialog or alert. */
export function useNetworkAccess(refreshMs = 5000) {
  const request = useConnectionRequest(create(ui.NetworkAccessSchema), async () =>
    decode(ui.NetworkAccessSchema, await requestJson("GET", "/api/network")),
  );

  let busy = $state(false);

  /** Throws the gateway's message (a busy port, an invalid hostname) to the caller. */
  async function update(action: string, extra: { [key: string]: JsonBody } = {}) {
    busy = true;

    try {
      request.set(decode(ui.NetworkAccessSchema, await requestJson("PUT", "/api/network", { action, ...extra })));

      return request.data;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void request.reload();

    const timer = setInterval(() => {
      if (!busy && !document.hidden) void request.reload();
    }, refreshMs);

    return () => clearInterval(timer);
  });

  return {
    get status() {
      return request.data;
    },
    get loaded() {
      return request.loaded;
    },
    get loading() {
      return request.loading;
    },
    get busy() {
      return busy;
    },
    get error() {
      return request.error;
    },
    reload: request.reload,
    update,
  };
}

export type NetworkAccessState = ReturnType<typeof useNetworkAccess>;
