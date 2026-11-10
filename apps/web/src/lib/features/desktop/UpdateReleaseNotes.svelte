<script lang="ts">
  import type { DesktopReleaseNote } from "@canopy/ui/desktop";
  import type { ClassValue } from "svelte/elements";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";

  let {
    releases,
    channel,
    source = "canopy",
    class: className,
  }: {
    releases: readonly DesktopReleaseNote[];
    channel: string;
    source?: "canopy" | "claude" | "codex";
    class?: ClassValue;
  } = $props();

  const notes = $derived(releases.filter((release) => !!release.markdown.trim()));
</script>

{#if notes.length}
  <div class={["grid gap-5", className]}>
    <h3 class="text-base font-medium text-zinc-950 sm:text-sm dark:text-white">What’s new · {channel}</h3>
    {#each notes as release (release.version)}
      <section class="grid min-w-0 gap-2">
        <h4 class="text-base font-medium tabular-nums select-text sm:text-sm">{release.version}</h4>
        <Markdown text={release.markdown} />
        <a
          href={`https://github.com/${source === "claude" ? "anthropics/claude-code" : source === "codex" ? "openai/codex" : "itsoltech/canopy"}/releases/tag/${source === "codex" ? "rust-v" : "v"}${encodeURIComponent(release.version)}`}
          target="_blank"
          rel="noreferrer"
          class="w-fit text-brand-600 underline focus-ring dark:text-brand-400">View release on GitHub</a
        >
      </section>
    {/each}
  </div>
{/if}
