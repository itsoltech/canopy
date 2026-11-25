<script lang="ts">
  import { CANOPY_VERSION } from "@canopy/domain/release/version";
  import { sidebarIdentity } from "@canopy/ui/sidebar-art";
  import { textTones } from "#lib/shared/ui/tone.ts";
  import Logo from "./Logo.svelte";

  let { channel }: { channel: keyof typeof sidebarIdentity } = $props();

  const identity = $derived(sidebarIdentity[channel]);
</script>

<div
  class="canopy-sidebar-header density-standard flex h-12 shrink-0 items-center pr-(--sidebar-row-inset) pl-(--sidebar-gutter)"
  data-release-channel={channel}
  data-window-drag
  title={`Canopy ${CANOPY_VERSION}${channel === "stable" ? "" : ` · ${identity.label}`}`}
>
  <Logo {channel}>
    {#snippet subtitle()}
      {#if channel !== "stable"}<div
          class={["truncate font-mono text-xs/4 font-medium tracking-wide", textTones[identity.tone]]}
        >
          {identity.label}
        </div>{/if}
    {/snippet}
  </Logo>
</div>
