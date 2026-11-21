<script lang="ts">
  import type { SkillArtifact } from "@canopy/contracts";
  import { environmentFileDiff, environmentFileText } from "@canopy/domain/environment-review";
  import { skillChanges } from "@canopy/domain/skill-source";
  import Diff from "#lib/features/threads/components/Diff.svelte";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import InstructionText from "./InstructionText.svelte";

  let { before, after }: { before: SkillArtifact; after: SkillArtifact } = $props();
  let path = $state("");
  const changes = $derived(skillChanges(before, after));
  const selected = $derived(changes.find((change) => change.path === path) ?? changes[0]);
  const previous = $derived(before.files.find((file) => file.path === selected?.path));
  const next = $derived(after.files.find((file) => file.path === selected?.path));
  const review = $derived(selected && environmentFileDiff(previous, next));
</script>

{#if selected && review}
  <ul
    role="list"
    aria-label="Changed files"
    class="grid max-h-48 min-w-0 gap-1 overflow-auto rounded-lg bg-zinc-950/3 p-1 text-base sm:text-sm dark:bg-white/4"
  >
    {#each changes as change (change.path)}
      <li class="min-w-0">
        <button
          type="button"
          class={[
            "flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md border px-2 py-1.5 text-left focus-ring focus-visible:-outline-offset-2 pointer-coarse:min-h-11",
            selected.path === change.path ? "border-accent/40 bg-accent/10" : "border-transparent hover:bg-zinc-500/10",
          ]}
          aria-pressed={selected.path === change.path}
          onclick={() => (path = change.path)}
        >
          <span class="min-w-0 font-mono wrap-anywhere">{change.path}</span>
          <span class={change.script ? "text-amber-700 dark:text-amber-300" : "text-muted"}>
            {change.kind}{change.script ? " · Script / executable" : ""}
          </span>
        </button>
      </li>
    {/each}
  </ul>
  {#if review.mode}<p class="text-base text-muted sm:text-sm">{review.mode}</p>{/if}
  {#if review.kind === "text"}
    {#if review.diff}
      {#key selected.path}
        <Diff
          diff={review.diff}
          lang={languageOfPath(selected.path)}
          label={`Changes to ${selected.path}`}
          toolbar={false}
          class="min-w-0"
        />
      {/key}
    {:else if !review.mode}<p class="text-base text-muted sm:text-sm">Empty file.</p>{/if}
  {:else}
    <div class="grid min-w-0 gap-3">
      <p class="text-base text-muted sm:text-sm">
        {review.kind === "binary"
          ? "Binary file."
          : "The diff is too large to display. Review the file versions below."}
      </p>
      {#each [{ label: "Current version", file: previous }, { label: "Upstream candidate", file: next }] as version (version.label)}
        {#if version.file}
          <div class="grid min-w-0 gap-1">
            <h4 class="text-base font-medium sm:text-sm">{version.label}</h4>
            <InstructionText class="max-h-64" content={environmentFileText(version.file)} empty="(Empty file)" />
          </div>
        {/if}
      {/each}
    </div>
  {/if}
{:else}
  <p class="text-base text-muted sm:text-sm">This commit has no file changes.</p>
{/if}
