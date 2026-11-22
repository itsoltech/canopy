<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
  import { sidebarIdentity } from "@canopy/ui/sidebar-art";
  import { textTones } from "#lib/shared/ui/tone.ts";
  import Logo from "./Logo.svelte";

  let {
    children,
    version = CANOPY_VERSION,
    class: className,
  }: { children: Snippet; version?: string; class?: ClassValue } = $props();

  const channel = $derived(releaseChannel(version));
  const identity = $derived(sidebarIdentity[channel]);
</script>

<div
  class={["relative isolate shrink-0", className]}
  data-release-channel={channel}
  title={`Canopy ${version}${channel === "stable" ? "" : ` · ${identity.label}`}`}
>
  <!-- The art extends below the macOS title strip. Only the adjacent header row should drag the window. -->
  <div
    class="channel-art pointer-events-none absolute inset-x-0 top-0 -bottom-10 -z-10 overflow-hidden"
    class:tinted={channel !== "stable"}
    style:--ink-light={identity.ink.light}
    style:--ink-dark={identity.ink.dark}
    aria-hidden="true"
  >
    <div class="channel-drawing absolute top-0 right-1 aspect-20/11 w-1/2 max-w-40">
      {@html identity.art}
    </div>
  </div>
  <div
    class="canopy-sidebar-header density-standard flex h-12 items-center justify-between gap-2 pr-(--sidebar-row-inset) pl-(--sidebar-gutter)"
    data-window-drag
  >
    <Logo
      label={`Canopy homepage, ${channel === "stable" ? "" : `${identity.label} build `}${version}`}
      class="min-w-0"
    >
      {#snippet subtitle()}
        {#if channel !== "stable"}<div
            class={["truncate font-mono text-xs/4 font-medium tracking-wide", textTones[identity.tone]]}
          >
            {identity.label}
          </div>{/if}
      {/snippet}
    </Logo>
    <div class="shrink-0">{@render children()}</div>
  </div>
</div>

<style>
  .channel-art {
    color: light-dark(var(--ink-light), var(--ink-dark));
    mask-image: linear-gradient(to bottom, black 53%, transparent);
  }
  .tinted {
    background: linear-gradient(to bottom, color-mix(in srgb, currentColor 9%, transparent), transparent);
  }
  /* In a narrow macOS column the window controls take the left gutter. Keep the tree between the name and action. */
  @container (max-width: 17rem) {
    :global(html[data-canopy-platform="darwin"]:not([data-window-fullscreen]))
      .canopy-sidebar-header
      :global(.sidebar-logo-tile) {
      display: none;
    }
    :global(html[data-canopy-platform="darwin"]:not([data-window-fullscreen])) .channel-drawing {
      right: 1rem;
      mask-image: linear-gradient(to right, transparent 39%, black 54% 81%, transparent 95%);
    }
  }
  @media (forced-colors: active) {
    .channel-art {
      display: none;
    }
  }
</style>
