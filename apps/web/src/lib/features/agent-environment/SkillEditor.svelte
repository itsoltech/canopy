<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ui, SkillFile } from "@canopy/contracts";
  import Input from "#lib/shared/ui/Input.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SkillDestinations from "./SkillDestinations.svelte";
  import SkillUpload from "./SkillUpload.svelte";
  import SkillOverrides from "./SkillOverrides.svelte";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";
  import SkillSourceFiles from "./SkillSourceFiles.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { create } from "@bufbuild/protobuf";
  import { SkillArtifactSchema } from "@canopy/contracts";

  let {
    skill = $bindable(),
    workers,
    busy,
    onupload,
    onsave,
    oncancel,
    files = [],
    zip,
    error = "",
    class: className,
  }: {
    skill: ui.LibrarySkill | undefined;
    workers: readonly ui.EnvironmentWorker[];
    busy: boolean;
    onupload: (files: SkillFile[], zip: Uint8Array) => void;
    onsave: () => void;
    oncancel: () => void;
    files?: SkillFile[];
    zip: Uint8Array;
    error?: string;
    class?: ClassValue;
  } = $props();

  let uploadReady = $state(true);
  let step = $state(0);
  let artifactVersion = $state(0n);

  $effect(() => {
    const current = skill;
    artifactVersion = untrack(() => current?.version ?? 0n);
  });

  $effect(() => {
    if (!skill) {
      step = 0;
      uploadReady = true;
    }
  });

  const artifact = $derived(files.length ? create(SkillArtifactSchema, { name: skill?.name, files }) : skill?.artifact);
</script>

<EnvironmentSheet
  bind:open={
    () => Boolean(skill),
    (value) => {
      if (!value) oncancel();
    }
  }
  title={skill?.id ? "Edit skill" : "Upload skill"}
  steps={["Files & version", "Review files", "Assign & confirm"]}
  bind:step
  {busy}
  {error}
  {onsave}
  class={className}
  nextDisabled={!uploadReady || (!skill?.id && !files.length && !zip.length)}
  submitDisabled={!uploadReady}
  submitLabel={skill?.id ? "Save and sync" : "Add and sync"}
>
  {#snippet children(current)}
    {#if skill}
      {#if current === 0}
        <Field label="Library name"
          ><Input
            name="skill-name"
            bind:value={skill.name}
            required
            maxlength={120}
            placeholder="For example, Code review"
          /></Field
        >
        <SkillUpload {onupload} onready={(ready) => (uploadReady = ready)} />
        {#if skill.id}
          <Field
            label="Library version"
            description="Choose an earlier version to roll back. A new upload creates a new immutable version."
          >
            <Select
              name="skill-version"
              value={skill.version.toString()}
              options={skill.versions.map((v) => ({ value: v.toString(), label: `Version ${v}` }))}
              onchange={(version) => {
                if (skill) skill.version = BigInt(version);
              }}
            />
          </Field>
          <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
            {skill.artifact?.name} · {skill.artifact?.files.length}
            {skill.artifact?.files.length === 1 ? "file" : "files"} · {skill.artifact?.description}
          </p>
        {/if}
        {#if skill.source}
          <p class="text-base wrap-anywhere text-zinc-500 sm:text-sm dark:text-zinc-400">
            Source: {skill.source.url} · {skill.source.ref}. Uploading new files detaches upstream tracking. Rolling
            back pins the selected version.
          </p>
          <Checkbox
            name="source-auto-update"
            label="Automatically update this skill"
            description="Check hourly. Script or executable changes always need review."
            bind:checked={skill.source.autoUpdate}
          />
          <Checkbox
            name="source-pinned"
            label="Pin this version"
            description="Pause periodic checks and automatic updates. Manual checks and reviewed updates remain available."
            bind:checked={skill.source.pinned}
          />
        {/if}
      {:else if current === 1}
        {#if skill.version !== artifactVersion && !files.length && !zip.length}<Alert>
            You selected library version {skill.version.toString()} for rollback. The files below show the currently assigned
            version {artifactVersion.toString()}; saving restores the selected stored version.
          </Alert>{/if}
        {#if zip.length}<Alert
            >The gateway validates and unpacks this ZIP when you confirm. For a file-by-file preview before adding, go
            Back and choose a folder.</Alert
          >
        {:else if artifact}<SkillSourceFiles {artifact} />{/if}
      {:else}
        <SkillDestinations bind:skill {workers} />
        {#if workers.length}<Disclosure>
            {#snippet summary()}<h3 class="text-base font-medium text-balance">Machine overrides</h3>{/snippet}
            <SkillOverrides class="pt-4" bind:skill {workers} />
          </Disclosure>{/if}
        <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
          Save and sync approves these files for the selected computers. Canopy does not run installers or skill scripts
          during sync.
        </p>
      {/if}
    {/if}
  {/snippet}
</EnvironmentSheet>
