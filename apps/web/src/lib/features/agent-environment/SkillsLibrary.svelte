<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import LibraryRow from "./LibraryRow.svelte";
  import LibraryTargets from "./LibraryTargets.svelte";
  import { librarySource } from "./library-meta.ts";
  import SkillEditor from "./SkillEditor.svelte";
  import SkillInstallerDialog from "./SkillInstallerDialog.svelte";
  import type { SkillArtifact, ui } from "@canopy/contracts";
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

  let {
    environment,
    notInstalled,
    oninstallerresult,
    onexisting,
    class: className,
  }: {
    environment: EnvironmentState;
    notInstalled: EnvironmentState["snapshot"]["skills"];
    oninstallerresult: (artifact: SkillArtifact, worker: ui.EnvironmentWorker, path: string) => void;
    onexisting: (workerId?: string) => void;
    class?: ClassValue;
  } = $props();

  const controller = new SkillsState(untrack(() => environment));
  let choose = $state(false);
  let sourceOpen = $state(false);
  let method = $state("source");
  let installerCommand = $state("");
  let installerOpen = $state(false);
  let selected = $state<string[]>([]);
  let installing = $state<string[]>([]);
  let removing = $state(false);
  let deleting = $state(false);
  let removalRevision = $state(0n);
  const chosen = $derived(environment.snapshot.skills.filter((s) => selected.includes(s.id)));

  function useInstaller(command = "") {
    sourceOpen = false;
    environment.error = "";
    installerCommand = command;
    installerOpen = true;
  }

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

<section class={["grid min-w-0 gap-3", className]} aria-label="Skill library">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-lg font-semibold text-balance">Skill library</h2>
    <div class="flex flex-wrap gap-2">
      {#if notInstalled.length}
        <Button
          size="sm"
          disabled={environment.busy || deleting}
          onclick={() => (installing = notInstalled.map((s) => s.id))}>Install unassigned skills…</Button
        >
      {/if}
      <Button size="sm" onclick={() => (choose = true)}>Add skill</Button>
    </div>
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
        This removes {chosen.length}
        {chosen.length === 1 ? "skill" : "skills"} from your shared library and from assigned computers.
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
      else if (method === "installer") useInstaller();
      else sourceOpen = true;
    }}
  >
    {#snippet children()}<Field label="Skill source"
        ><Select
          name="skill-add-method"
          bind:value={method}
          options={[
            { value: "source", label: "Import from a URL or command" },
            { value: "installer", label: "Use a custom installer" },
            { value: "upload", label: "Upload a folder or ZIP" },
          ]}
        /></Field
      >{/snippet}
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
  <SkillInstallerDialog
    bind:open={installerOpen}
    bind:command={installerCommand}
    workers={environment.snapshot.workers}
    oncollect={oninstallerresult}
    {onexisting}
    onupload={() => controller.edit()}
  />
  <SkillSourceImport {environment} bind:open={sourceOpen} oninstaller={useInstaller} />
  <div class="grid divide-y divide-zinc-950/10 dark:divide-white/10">
    {#each environment.snapshot.skills as skill (skill.id)}
      {@const matching = assignedWorkers(environment.workers, skill.selector, skill.overrides)}
      {@const files = skill.artifact?.files.length ?? 0}
      <LibraryRow
        id={skill.id}
        name={skill.name}
        meta={[
          skill.harnesses.filter(Boolean).join(" / "),
          `v${skill.version}`,
          `${files} ${files === 1 ? "file" : "files"}`,
          librarySource(skill.source?.url),
          skill.source
            ? skill.source.pinned
              ? "Pinned"
              : skill.source.autoUpdate
                ? "Automatic updates"
                : "Manual updates"
            : "",
        ]
          .filter(Boolean)
          .join(" · ")}
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
        <h3 class="text-base font-medium text-balance">No skills yet</h3>
        <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
          Add skills from a website, a Git repository, a folder or a ZIP file.
        </p>
      </div>
    {/each}
  </div>
</section>
