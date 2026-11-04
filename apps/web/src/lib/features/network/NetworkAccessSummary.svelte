<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { networkSummary } from "./network.ts";

  /** Network access at a glance on the pages that need it (Mobile devices, Linked computers): where this
   * computer is reachable, or a one-click "Turn on". Details live in Settings → Network access. */
  let {
    status,
    loaded,
    busy = false,
    onenable,
    class: className,
  }: { status: ui.NetworkAccess; loaded: boolean; busy?: boolean; onenable: () => void; class?: ClassValue } = $props();

  const tone = $derived(status.state === "on" ? "emerald" : status.state === "error" ? "rose" : "neutral");

  const title = $derived(
    !loaded
      ? "Checking network access…"
      : status.state === "on"
        ? "Network access is on"
        : status.state === "error"
          ? "Network access can't start"
          : "Network access is off",
  );
</script>

<SettingsGroup class={className}>
  <SettingsRow
    {title}
    description={loaded ? [networkSummary(status), status.note].filter(Boolean).join(" ") : undefined}
  >
    {#snippet leading()}<StatusDot {tone} />{/snippet}
    {#snippet control()}
      {#if loaded && !status.enabled}<Button size="sm" disabled={busy} loading={busy} onclick={onenable}>Turn on</Button
        >{/if}
      <ButtonLink size="sm" variant="ghost" href="/settings/network">Manage</ButtonLink>
    {/snippet}
  </SettingsRow>
</SettingsGroup>
