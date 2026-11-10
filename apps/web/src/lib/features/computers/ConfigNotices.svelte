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
  import Button from "#lib/shared/ui/Button.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";

  /** Notices of one place in Settings: which items it shows is up to the caller. */
  let {
    match,
    title = "Changed on two computers",
    named = true,
    library = false,
    onchange,
    class: className,
  }: {
    match: (notice: ui.ConfigNotice) => boolean;
    title?: string;
    named?: boolean;
    library?: boolean;
    /** Refresh the item after restoring a value or resolving a choice. */
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

  const deleted = $derived(visible.filter((n) => n.reason === "deleted" && n.field === "deleted"));

  async function act(ids: string[], action: "restore" | "dismiss") {
    busy = true;
    error = "";

    try {
      for (const id of ids) {
        const response = decode(
          ui.ComputersSnapshotSchema,
          await requestJson("PUT", "/api/computers/notices", { id, action }),
        );

        computers.set(response);
      }

      onchange?.();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not update this notice. Try again.";
    } finally {
      busy = false;
      onchange?.();
    }
  }

  onMount(() => (capabilities?.linkedComputers ? revalidateEvery("GetComputers", 60_000) : undefined));
</script>

{#if visible.length}
  <SettingsGroup {title} class={className}>
    {#if library}<div class="grid gap-2 px-4 py-3">
        <p class="text-base text-pretty text-muted sm:text-sm">
          Linked computers share library changes.
          {#if deleted.length}Keep restores deleted items to your library. Accept deletion leaves them removed.{/if}
        </p>
        {#if deleted.length > 1}<div>
            <DropdownMenu label="Resolve all deletions">
              {#snippet trigger(props)}<Button size="sm" disabled={busy} {...props}>Resolve all…</Button>{/snippet}
              <MenuItem
                disabled={busy}
                onselect={() =>
                  void act(
                    deleted.map((n) => n.id),
                    "restore",
                  )}>Keep all deleted items</MenuItem
              >
              <MenuItem
                disabled={busy}
                onselect={() =>
                  void act(
                    deleted.map((n) => n.id),
                    "dismiss",
                  )}>Accept all deletions</MenuItem
              >
            </DropdownMenu>
          </div>{/if}
      </div>{/if}
    {#each visible as notice (notice.id)}<ConfigNotice
        {notice}
        {named}
        {library}
        {busy}
        onaction={(id, action) => void act([id], action)}
      />{/each}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
  </SettingsGroup>
{/if}
