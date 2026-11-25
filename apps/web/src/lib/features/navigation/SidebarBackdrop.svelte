<script lang="ts">
  import { sidebarIdentity } from "@canopy/ui/sidebar-art";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import SeasonalSidebarAccent from "./SeasonalSidebarAccent.svelte";
  import { seasonalAccentFor, type SeasonalAccent } from "./seasonal-accents.ts";

  let { channel }: { channel: keyof typeof sidebarIdentity } = $props();
  const identity = $derived(sidebarIdentity[channel]);
  let accent = $state<SeasonalAccent | null>(null);

  $effect(() => {
    if (devicePreferences.values.seasonalAccents === "off") {
      accent = null;

      return;
    }

    let timer: ReturnType<typeof setTimeout>;

    function updateAccent() {
      clearTimeout(timer);
      const now = new Date();
      accent = seasonalAccentFor(now);
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(updateAccent, midnight.getTime() - now.getTime());
    }

    updateAccent();
    window.addEventListener("focus", updateAccent);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", updateAccent);
    };
  });
</script>

<div
  class="sidebar-watermark pointer-events-none absolute inset-0 -z-10 overflow-hidden forced-colors:hidden"
  style:background-image={identity.gradient}
  style:--ink-light={identity.ink.light}
  style:--ink-dark={identity.ink.dark}
  aria-hidden="true"
>
  {@html identity.art}
  {#if accent}<SeasonalSidebarAccent {accent} />{/if}
</div>

<style>
  .sidebar-watermark {
    color: light-dark(var(--ink-light), var(--ink-dark));
    background-size: 100% min(5.5rem, 100%);
    background-repeat: no-repeat;
  }
</style>
