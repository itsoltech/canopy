<script lang="ts">
  import type { DesktopReleaseNote } from "@canopy/ui/desktop";
  import type { ClassValue } from "svelte/elements";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";

  let {
    releases,
    channel,
    class: className,
  }: { releases: readonly DesktopReleaseNote[]; channel: string; class?: ClassValue } = $props();
</script>

<div class={["grid gap-5", className]}>
  <h3 class="text-base font-medium text-zinc-950 sm:text-sm dark:text-white">What’s new · {channel}</h3>
  {#each releases as release (release.version)}
    <section class="grid min-w-0 gap-2">
      <h4 class="text-base font-medium tabular-nums sm:text-sm">{release.version}</h4>
      <Markdown text={release.markdown} />
      <a
        href={`https://github.com/itsoltech/canopy/releases/tag/v${encodeURIComponent(release.version)}`}
        target="_blank"
        rel="noreferrer"
        class="w-fit text-brand-600 underline focus-ring dark:text-brand-400">View release on GitHub</a
      >
    </section>
  {:else}
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      No release notes are available for this update.
    </p>
  {/each}
  {#if channel === "nightly"}
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Older nightly releases may have been removed from GitHub. Only published release notes are shown.
    </p>
  {/if}
</div>
