<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import ImportThreadRow from "./ImportThreadRow.svelte";
  import type { ImportState } from "./import-state.svelte.ts";
  import { counted, size } from "./labels.ts";

  /** Matching threads grouped by their directory, with where each directory goes (docs/import.md). */
  let { imports }: { imports: ImportState } = $props();

  const result = $derived(imports.result);

  const sections = $derived.by(() => {
    const groups = new Map((result?.groups ?? []).map((g) => [g.directory, g]));
    const byDirectory = new Map<string, ui.ImportCandidate[]>();

    for (const c of result?.candidates ?? []) byDirectory.set(c.cwd, [...(byDirectory.get(c.cwd) ?? []), c]);

    return [...byDirectory].map(([directory, candidates]) => ({ directory, candidates, group: groups.get(directory) }));
  });

  function target(group: ui.ImportDirectoryGroup | undefined): string {
    const s = group?.suggestion;

    if (!s || s.kind === "missing") return "Directory no longer exists. Threads import as history.";

    if (s.kind === "workspace") return `Project ${s.projectName}`;

    return "New project";
  }

  const all = (candidates: readonly ui.ImportCandidate[]) => candidates.every((c) => imports.isSelected(c.sourceKey));
  const some = (candidates: readonly ui.ImportCandidate[]) => candidates.some((c) => imports.isSelected(c.sourceKey));
</script>

{#each sections as section (section.directory)}
  {@const id = `import-group-${section.directory}`}
  <section aria-labelledby={id} class="border-t border-zinc-950/5 first:border-t-0 dark:border-white/5">
    <div class="flex items-start gap-3 bg-zinc-50 px-4 py-2 dark:bg-white/2.5">
      <div class="flex h-lh items-center text-base/6 sm:text-sm/6">
        <ChoiceControl
          name="importGroup"
          aria-label={`Import all threads in ${section.directory || "an unknown directory"}`}
          checked={all(section.candidates)}
          indeterminate={!all(section.candidates) && some(section.candidates)}
          onchange={(event) => {
            for (const c of section.candidates) imports.toggle(c.sourceKey, event.currentTarget.checked);
          }}
        />
      </div>
      <div class="min-w-0 flex-1 text-base/6 sm:text-sm/6">
        <h3 {id} class="min-w-0 font-mono text-zinc-950 dark:text-white">
          <TruncatedText text={section.directory || "Unknown directory"} />
        </h3>
        <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
          {target(section.group)} · {counted(section.group?.threads ?? section.candidates.length, "thread")} ·
          {size(section.group?.bytes ?? 0n)}
        </p>
      </div>
    </div>
    <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/5">
      {#each section.candidates as candidate (candidate.sourceKey)}
        <ImportThreadRow
          {candidate}
          selected={imports.isSelected(candidate.sourceKey)}
          onselect={(selected) => imports.toggle(candidate.sourceKey, selected)}
        />
      {/each}
    </ul>
  </section>
{:else}
  <p class="px-4 py-6 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    No threads match these filters. Choose a longer period or another agent CLI.
  </p>
{/each}
{#if result && result.candidates.length < result.total}
  <div class="border-t border-zinc-950/5 px-4 py-3 dark:border-white/5">
    <Button variant="secondary" loading={imports.loading} onclick={() => imports.showMore()}>
      Show more ({(result.total - result.candidates.length).toLocaleString("en")})
    </Button>
  </div>
{/if}
