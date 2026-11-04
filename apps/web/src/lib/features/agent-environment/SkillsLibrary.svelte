<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import LibraryRow from "./LibraryRow.svelte";
  import LibraryTargets from "./LibraryTargets.svelte";
  import { librarySource } from "./library-meta.ts";
  import SkillEditor from "./SkillEditor.svelte";
  import SkillSourceImport from "./SkillSourceImport.svelte";
  import SkillSourceUpdate from "./SkillSourceUpdate.svelte";
  import { SkillsState } from "./skills-state.svelte.ts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";
  import ItemStatus from "./ItemStatus.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";

  let { environment, class: className }: { environment: EnvironmentState; class?: ClassValue } = $props();
  const controller = new SkillsState(untrack(() => environment));
  let choose = $state(false);
  let sourceOpen = $state(false);
  let method = $state("source");
</script>

<section
  class={["grid min-w-0 gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10", className]}
  aria-label="Skill library"
>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-lg font-semibold text-balance">Skill library</h2>
    <Button size="sm" onclick={() => (choose = true)}>Add skill</Button>
  </div>
  <EnvironmentSheet
    bind:open={choose}
    title="Add skill"
    steps={["Choose how to add"]}
    submitLabel="Next"
    onsave={() => {
      choose = false;
      environment.error = "";
      if (method === "upload") controller.edit();
      else sourceOpen = true;
    }}
  >
    {#snippet children()}<Field label="Skill source"
        ><Select
          name="skill-add-method"
          bind:value={method}
          options={[
            { value: "source", label: "Git repository or npx skills add command" },
            { value: "upload", label: "Upload a folder or ZIP" },
          ]}
        /></Field
      >
      <p class="text-base text-muted sm:text-sm">
        Review the files, choose tags or computers, then confirm. Pasted commands are parsed without running them.
      </p>{/snippet}
  </EnvironmentSheet>
  <SkillEditor
    bind:skill={controller.draft}
    workers={environment.snapshot.workers}
    busy={environment.busy}
    files={controller.files}
    zip={controller.zip}
    error={environment.error}
    onupload={(files, zip) => {
      controller.files = files;
      controller.zip = zip;
    }}
    onsave={() => controller.save()}
    oncancel={() => (controller.draft = undefined)}
  />
  <SkillSourceImport {environment} bind:open={sourceOpen} />
  <div class="grid divide-y divide-zinc-950/10 dark:divide-white/10">
    {#each environment.snapshot.skills as skill (skill.id)}
      <LibraryRow
        id={skill.id}
        name={skill.name}
        meta={`${skill.harnesses.join(" / ")} · v${skill.version} · ${skill.artifact?.files.length ?? 0} files · ${librarySource(skill.source?.url)}${skill.source ? ` · ${skill.source.pinned ? "Pinned" : skill.source.autoUpdate ? "Automatic updates" : "Manual updates"}` : ""}`}
        disabled={environment.busy}
        editLabel="Edit skill"
        removeLabel="Delete skill"
        onedit={() => {
          environment.error = "";
          controller.edit(skill);
        }}
        onremove={() => void controller.remove(skill)}
      >
        {#snippet status()}
          <ItemStatus
            workers={environment.snapshot.workers}
            selector={skill.selector}
            disabled={skill.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
            kind="skills"
            id={skill.id}
            label={skill.source?.availableCommit ? "Update available" : skill.source?.error ? "Needs review" : ""}
          />
        {/snippet}
        {#snippet targets()}<LibraryTargets
            selector={skill.selector}
            workers={environment.snapshot.workers}
            disabled={skill.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
          />{/snippet}
        {#snippet actions()}<SkillSourceUpdate {skill} {environment} />{/snippet}
      </LibraryRow>
    {:else}
      <div class="grid gap-2 rounded-xl bg-zinc-950/3 p-5 dark:bg-white/4">
        <h3 class="text-base font-medium text-balance">Give your agents a new skill</h3>
        <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
          Upload a skill folder or ZIP, choose its computers, and keep every installed version in sync.
        </p>
        <div><Button onclick={() => (choose = true)}>Add your first skill</Button></div>
      </div>
    {/each}
  </div>
</section>
