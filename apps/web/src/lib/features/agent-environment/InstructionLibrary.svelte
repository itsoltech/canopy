<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import DocumentEditor from "./DocumentEditor.svelte";
  import LibraryRow from "./LibraryRow.svelte";
  import LibraryTargets from "./LibraryTargets.svelte";
  import ItemStatus from "./ItemStatus.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let { state, class: className }: { state: EnvironmentState; class?: ClassValue } = $props();
</script>

<section class={["grid min-w-0 gap-4", className]} aria-label="Instruction library">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-lg font-semibold text-balance">Instruction library</h2>
    <Button size="sm" onclick={() => state.edit()}>Add document</Button>
  </div>
  <DocumentEditor
    bind:document={state.draft}
    workers={state.snapshot.workers}
    busy={state.busy}
    conflict={state.editConflict}
    error={state.error}
    onsave={() => state.save()}
    onreload={() => state.reloadDraft()}
    oncancel={() => (state.draft = undefined)}
  />
  <div class="grid min-w-0 divide-y divide-divider">
    {#each state.snapshot.documents as document (document.id)}
      <LibraryRow
        id={document.id}
        name={document.name}
        meta={[
          document.harness === "claude" ? "CLAUDE.md" : "AGENTS.md",
          `v${document.revision}`,
          `${document.fragments.length} ${document.fragments.length === 1 ? "fragment" : "fragments"}`,
          "Library",
        ]
          .filter(Boolean)
          .join(" · ")}
        disabled={state.busy}
        onedit={() => state.edit(document)}
        onremove={() => void state.remove(document)}
        editLabel="Edit document"
        removeLabel="Delete document"
      >
        {#snippet status()}
          <ItemStatus
            workers={state.workers}
            selector={document.selector}
            disabled={document.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
            kind="instructions"
            id={document.id}
            harness={document.harness}
          />
        {/snippet}
        {#snippet targets()}<LibraryTargets
            selector={document.selector}
            workers={state.workers}
            disabled={document.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
          />{/snippet}
      </LibraryRow>
    {:else}
      <div class="grid gap-3 rounded-xl bg-zinc-950/3 p-5 dark:bg-white/4">
        <h3 class="font-medium text-balance">Make every agent feel at home</h3>
        <p class="text-base text-pretty text-muted sm:text-sm">
          Add a document and assign it to see what agents receive.
        </p>
        <div><Button onclick={() => state.edit()}>Add your first document</Button></div>
      </div>
    {/each}
  </div>
</section>
