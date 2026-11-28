<script lang="ts">
  import type { DesktopReleaseNote } from "@canopy/ui/desktop";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";

  let {
    releases,
    title,
  }: {
    releases: readonly DesktopReleaseNote[];
    title: string;
  } = $props();
</script>

<div class="break-anywhere grid gap-5">
  <h3 class="text-base font-medium text-zinc-950 sm:text-sm dark:text-white">{title}</h3>
  {#each releases as release (release.version)}
    <section class="grid min-w-0 gap-2">
      <h4 class="text-base font-medium tabular-nums select-text sm:text-sm">{release.version}</h4>
      <Markdown text={release.markdown} />
      <a
        href={`https://github.com/itsoltech/canopy/releases/tag/v${encodeURIComponent(release.version)}`}
        target="_blank"
        rel="noreferrer"
        class="w-fit text-brand-600 underline focus-ring dark:text-brand-400">View release on GitHub</a
      >
    </section>
  {/each}
</div>
