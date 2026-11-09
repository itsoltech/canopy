<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { ui } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import ConfigNotice from "./ConfigNotice.svelte";

  /** Notices of one place in Settings: which items it shows is up to the caller. */
  let {
    match,
    title = "Changed on two computers",
    named = true,
    onchange,
    class: className,
  }: {
    match: (notice: ui.ConfigNotice) => boolean;
    title?: string;
    named?: boolean;
    /** Refresh the item after restoring a value or resolving a choice. */
    onchange?: () => void;
    class?: ClassValue;
  } = $props();

  const capabilities = useGatewayCapabilities();
  let notices = $state<ui.ConfigNotice[]>([]);
  let error = $state("");
  let busy = $state(false);

  const visible = $derived(notices.filter((n) => match(n)));

  async function reload() {
    if (!capabilities?.linkedComputers) return;
    const response = decode(ui.ComputersSnapshotSchema, await requestJson("GET", "/api/computers"));
    notices = response.configNotices;
  }

  async function act(id: string, action: "restore" | "dismiss") {
    busy = true;
    error = "";

    try {
      const response = decode(
        ui.ComputersSnapshotSchema,
        await requestJson("PUT", "/api/computers/notices", { id, action }),
      );

      notices = response.configNotices;

      onchange?.();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not update this notice. Try again.";
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void reload().catch(() => {});

    const timer = setInterval(() => {
      if (!document.hidden && !busy) void reload().catch(() => {});
    }, 3000);

    return () => clearInterval(timer);
  });
</script>

{#if visible.length}
  <SettingsGroup {title} class={className}>
    {#each visible as notice (notice.id)}<ConfigNotice
        {notice}
        {named}
        {busy}
        onaction={(id, action) => void act(id, action)}
      />{/each}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
  </SettingsGroup>
{/if}
