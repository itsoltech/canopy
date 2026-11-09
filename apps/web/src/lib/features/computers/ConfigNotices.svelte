<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { ui } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { revalidateEvery, sharedRead } from "#lib/shared/queries.svelte.ts";
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
    /** After Restore: the item changed here too. */
    onchange?: () => void;
    class?: ClassValue;
  } = $props();

  const capabilities = useGatewayCapabilities();

  // One shared computers snapshot for every notice list and the Computers page; computer and configuration
  // events refresh it, with one 60 s visible check for notices that arrive without an event.
  const computers = sharedRead("GetComputers", ui.ComputersSnapshotSchema, "/api/computers");
  let error = $state("");
  let busy = $state(false);

  const notices = $derived(capabilities?.linkedComputers ? (computers.data?.configNotices ?? []) : []);
  const visible = $derived(notices.filter((n) => match(n)));

  async function act(id: string, action: "restore" | "dismiss") {
    busy = true;
    error = "";

    try {
      const response = decode(
        ui.ComputersSnapshotSchema,
        await requestJson("PUT", "/api/computers/notices", { id, action }),
      );

      computers.set(response);

      if (action === "restore") onchange?.();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not update this notice. Try again.";
    } finally {
      busy = false;
    }
  }

  onMount(() => (capabilities?.linkedComputers ? revalidateEvery("GetComputers", 60_000) : undefined));
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
