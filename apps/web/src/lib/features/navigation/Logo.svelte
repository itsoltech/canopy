<script lang="ts">
  import type { Snippet } from "svelte";
  import { appIdentity, type AppChannel } from "@canopy/domain/release/identity";

  let { channel, subtitle }: { channel: AppChannel; subtitle?: Snippet } = $props();
</script>

<div class="flex min-w-0 items-center gap-2 text-base/6 font-semibold text-zinc-950 dark:text-white">
  <img
    src={`${appIdentity(channel).assets}/icon.svg`}
    alt=""
    draggable="false"
    width="32"
    height="32"
    class="sidebar-logo-tile size-8 shrink-0"
  />
  <div class="min-w-0">
    <div class="truncate leading-5">Canopy</div>
    {@render subtitle?.()}
  </div>
</div>
