<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
  import type { Tone } from "#lib/shared/ui/tone.ts";
  import { textTones } from "#lib/shared/ui/tone.ts";
  import Logo from "./Logo.svelte";

  let { children, version = CANOPY_VERSION, class: className }: { children: Snippet; version?: string; class?: ClassValue } = $props();
  const channel = $derived(releaseChannel(version));
  const identity = $derived(({
    stable: { label: "Stable", tone: "neutral", surface: "", rings: "" },
    beta: { label: "Beta", tone: "amber", surface: "bg-amber-500/6", rings: "border-amber-600/15 dark:border-amber-400/15" },
    nightly: { label: "Nightly", tone: "violet", surface: "bg-violet-500/6", rings: "border-violet-600/15 dark:border-violet-400/15" },
    development: { label: "Dev", tone: "neutral", surface: "bg-zinc-500/5", rings: "border-zinc-600/10 dark:border-zinc-400/10" },
  } satisfies Record<typeof channel, { label: string; tone: Tone; surface: string; rings: string }>)[channel]);
</script>

<div class={["canopy-sidebar-header relative isolate flex h-12 shrink-0 items-center justify-between gap-2 pr-2 pl-4", identity.surface, className]} data-release-channel={channel} title={`Canopy ${version}${channel === "stable" ? "" : ` · ${identity.label}`}`}>
  <!-- Quiet tree-ring contours: build identity, with no animation or imagery behind the navigation. -->
  {#if channel !== "stable"}
    <div class="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      {#each [0, 1, 2] as ring}
        <div class={["absolute top-1/2 right-8 h-(--ring-height) w-(--ring-width) -translate-y-1/2 -rotate-24 rounded-[50%] border", identity.rings]}
          style:--ring-width={`${10 + ring * 3}rem`} style:--ring-height={`${5 + ring * 1.5}rem`}></div>
      {/each}
    </div>
  {/if}
  <Logo label={`Canopy homepage, ${channel === "stable" ? "" : `${identity.label} build `}${version}`} class="min-w-0">
    {#snippet subtitle()}
      {#if channel !== "stable"}<div class={["truncate font-mono text-xs/4 font-medium tracking-wide", textTones[identity.tone]]}>{identity.label}</div>{/if}
    {/snippet}
  </Logo>
  <div class="shrink-0">{@render children()}</div>
</div>
