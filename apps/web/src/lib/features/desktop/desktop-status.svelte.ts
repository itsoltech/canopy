import { onMount } from "svelte";
import type { DesktopStatus } from "@canopy/ui/desktop";

/** Read this computer's runtime state independently of the gateway. */
export function useDesktopStatus() {
  let status = $state<DesktopStatus>();

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge) return;

    const off = bridge.onStatus((value) => {
      status = value;
    });

    void bridge.status().then(
      (value) => (status ??= value),
      () => {},
    );

    return off;
  });

  return {
    get status() {
      return status;
    },
    get remoteAddress() {
      const saved = status?.configuration;

      return saved?.mode === "remote" ? saved.gatewayUrl : undefined;
    },
  };
}
