<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import AssignmentSummary from "./AssignmentSummary.svelte";
  import SkillEditor from "./SkillEditor.svelte";
  import { SkillsState } from "./skills-state.svelte.ts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let { environment, class: className }: { environment: EnvironmentState; class?: ClassValue } = $props();
  const state = new SkillsState(untrack(() => environment));
</script>

<section
  class={["grid min-w-0 gap-4 border-t border-zinc-950/10 pt-6 dark:border-white/10", className]}
  aria-label="Skill library"
>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-lg font-semibold text-balance">Skill library</h2>
    {#if !state.draft}<Button size="sm" onclick={() => state.edit()}>Add skill</Button>{/if}
  </div>
  {#if state.draft}
    {#key state.draft.id}
      <SkillEditor
        bind:skill={state.draft}
        workers={environment.snapshot.workers}
        busy={environment.busy}
        onupload={(files, zip) => {
          state.files = files;
          state.zip = zip;
        }}
        onsave={() => state.save()}
        oncancel={() => (state.draft = undefined)}
      />
    {/key}
    {#if environment.error}<Alert tone="warning"
        >If the environment changed while you were editing, cancel and reopen the saved skill before trying again.</Alert
      >{/if}
  {:else}
    <div class="grid divide-y divide-zinc-950/10 dark:divide-white/10">
      {#each environment.snapshot.skills as skill (skill.id)}
        <div class="grid min-w-0 gap-2 py-3 first:pt-0 last:pb-0">
          <div class="flex min-w-0 items-center gap-3">
            <button
              type="button"
              class="relative grid min-w-0 flex-1 gap-1 rounded-md py-1 text-left focus-ring hover:text-brand-600 dark:hover:text-brand-400"
              onclick={() => state.edit(skill)}
            >
              <TouchTarget />
              <p class="truncate text-base font-medium sm:text-sm">{skill.name}</p>
              <p class="text-base text-zinc-500 tabular-nums sm:text-sm dark:text-zinc-400">
                {skill.harnesses.join(" · ")} · v{skill.version.toString()} · {skill.artifact?.files.length}
                {skill.artifact?.files.length === 1 ? "file" : "files"}
              </p>
            </button>
            <Button size="sm" variant="ghost" disabled={environment.busy} onclick={() => state.remove(skill)}
              >Delete</Button
            >
          </div>
          <AssignmentSummary
            selector={skill.selector}
            workers={environment.snapshot.workers}
            disabled={skill.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
          />
        </div>
      {:else}
        <div class="grid gap-2 rounded-xl bg-zinc-950/3 p-5 dark:bg-white/4">
          <h3 class="text-base font-medium text-balance">Give your agents a new skill</h3>
          <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
            Upload a skill folder or ZIP, choose its computers, and keep every installed version in sync.
          </p>
        </div>
      {/each}
    </div>
  {/if}
</section>
