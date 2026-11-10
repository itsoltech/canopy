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
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import SkillInstall from "./SkillInstall.svelte";
  import { assignedWorkers } from "@canopy/domain/environment-library";

  let { environment, class: className }: { environment: EnvironmentState; class?: ClassValue } = $props();
  const controller = new SkillsState(untrack(() => environment));
  let choose = $state(false);
  let sourceOpen = $state(false);
  let method = $state("source");
  let selected = $state<string[]>([]);
  let installing = $state<string[]>([]);
  let removing = $state(false);
  let deleting = $state(false);
  let removalRevision = $state(0n);
  const chosen = $derived(environment.snapshot.skills.filter((s) => selected.includes(s.id)));

  async function removeSelected() {
    deleting = true;
    let count = 0;
    let revision = removalRevision;

    for (const skill of chosen) {
      const saved = await controller.remove(skill, revision);

      if (!saved) break;
      revision = saved.revision;
      selected = selected.filter((id) => id !== skill.id);
      count++;
    }

    deleting = false;
    removing = false;

    if (!environment.error)
      environment.notice = `Removed ${count} ${count === 1 ? "skill" : "skills"} from your shared library.`;
  }
</script>

<section
  class={["grid min-w-0 gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10", className]}
  aria-label="Skill library"
>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-lg font-semibold text-balance">Skill library</h2>
    <Button size="sm" onclick={() => (choose = true)}>Add skill</Button>
  </div>
  {#if environment.snapshot.skills.length}
    <div class="flex min-h-12 flex-wrap items-center gap-2">
      <ChoiceControl
        type="checkbox"
        name="select-all-skills"
        aria-label="Select all skills"
        checked={chosen.length === environment.snapshot.skills.length}
        disabled={environment.busy || deleting}
        onchange={(event) =>
          (selected = event.currentTarget.checked ? environment.snapshot.skills.map((s) => s.id) : [])}
      />
      <p class="min-w-16 text-sm tabular-nums" role="status">{chosen.length} selected</p>
      <Button
        size="sm"
        disabled={!chosen.length || environment.busy || deleting}
        onclick={() => (installing = chosen.map((s) => s.id))}>Install on…</Button
      >
      <Button
        size="sm"
        disabled={!chosen.length || environment.busy || deleting}
        onclick={() => {
          removalRevision = environment.snapshot.revision;
          removing = true;
        }}>Remove from library</Button
      >
    </div>
  {/if}
  <SkillInstall bind:ids={installing} {environment} />
  <Dialog bind:open={removing} title="Remove skills from library?" dismissible={!deleting}>
    <div class="grid gap-4">
      <p class="text-base text-pretty sm:text-sm">
        Remove {chosen.length} skills from your shared library? This also removes their installations from assigned computers.
      </p>
      {#if !deleting && removalRevision !== environment.snapshot.revision}<p class="text-base text-muted sm:text-sm">
          The library changed. Cancel and review your selection before removing skills.
        </p>{/if}
      <div class="flex flex-wrap justify-end gap-2">
        <Button disabled={deleting} onclick={() => (removing = false)}>Cancel</Button><Button
          variant="danger"
          disabled={removalRevision !== environment.snapshot.revision}
          loading={deleting}
          onclick={removeSelected}>Remove from library</Button
        >
      </div>
    </div>
  </Dialog>
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
        Review the files, choose tags or computers, then confirm. Canopy reads pasted commands without running them.
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
      {@const matching = assignedWorkers(environment.workers, skill.selector, skill.overrides)}
      {@const files = skill.artifact?.files.length ?? 0}
      <LibraryRow
        id={skill.id}
        name={skill.name}
        meta={`${skill.harnesses.join(" / ")} · v${skill.version} · ${files} ${files === 1 ? "file" : "files"} · ${librarySource(skill.source?.url)}${skill.source ? ` · ${skill.source.pinned ? "Pinned" : skill.source.autoUpdate ? "Automatic updates" : "Manual updates"}` : ""}`}
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
            workers={environment.workers}
            selector={skill.selector}
            disabled={skill.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
            kind="skills"
            id={skill.id}
            label={skill.source?.availableCommit ? "Update available" : skill.source?.error ? "Needs review" : ""}
          />
        {/snippet}
        {#snippet selection()}<ChoiceControl
            type="checkbox"
            name={`select-skill-${skill.id}`}
            aria-label={`Select ${skill.name}`}
            checked={selected.includes(skill.id)}
            disabled={environment.busy || deleting}
            onchange={(event) =>
              (selected = event.currentTarget.checked
                ? [...selected, skill.id]
                : selected.filter((id) => id !== skill.id))}
          />{/snippet}
        {#snippet targets()}{#if matching.length}<LibraryTargets
              selector={skill.selector}
              workers={environment.workers}
              disabled={skill.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
            />{/if}{/snippet}
        {#snippet actions()}{#if !matching.length}<Button
              size="sm"
              disabled={environment.busy || deleting}
              onclick={() => (installing = [skill.id])}>Install…</Button
            >{/if}<SkillSourceUpdate {skill} {environment} />{/snippet}
      </LibraryRow>
    {:else}
      <div class="grid gap-2 rounded-xl bg-zinc-950/3 p-5 dark:bg-white/4">
        <h3 class="text-base font-medium text-balance">Give your agents a new skill</h3>
        <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
          Upload a skill folder or ZIP file and choose its computers. Canopy keeps every copy in sync.
        </p>
        <div><Button onclick={() => (choose = true)}>Add your first skill</Button></div>
      </div>
    {/each}
  </div>
</section>
