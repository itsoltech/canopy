<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui, SkillFile } from "@canopy/contracts";
  import Input from "#lib/shared/ui/Input.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SkillDestinations from "./SkillDestinations.svelte";
  import SkillUpload from "./SkillUpload.svelte";
  import SkillOverrides from "./SkillOverrides.svelte";

  let {
    skill = $bindable(),
    workers,
    busy,
    onupload,
    onsave,
    oncancel,
    class: className,
  }: {
    skill: ui.LibrarySkill;
    workers: readonly ui.EnvironmentWorker[];
    busy: boolean;
    onupload: (files: SkillFile[], zip: Uint8Array) => void;
    onsave: () => void;
    oncancel: () => void;
    class?: ClassValue;
  } = $props();

  let uploadReady = $state(true);
</script>

<form
  class={["grid min-w-0 gap-5 rounded-xl p-4 ring-1 ring-zinc-950/10 sm:p-5 dark:ring-white/10", className]}
  onsubmit={(event) => {
    event.preventDefault();
    onsave();
  }}
>
  <fieldset class="grid min-w-0 gap-5" disabled={busy}>
    <legend class="sr-only">Skill assignment</legend>
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
          onchange={(version) => (skill.version = BigInt(version))}
        />
      </Field>
      <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
        {skill.artifact?.name} · {skill.artifact?.files.length}
        {skill.artifact?.files.length === 1 ? "file" : "files"} · {skill.artifact?.description}
      </p>
    {/if}
    {#if skill.source}
      <p class="text-base wrap-anywhere text-zinc-500 sm:text-sm dark:text-zinc-400">
        Source: {skill.source.url} · {skill.source.ref}. Uploading new files detaches upstream tracking. Rolling back
        pins the selected version.
      </p>
      <Checkbox
        name="source-auto-update"
        label="Automatically update this skill"
        description="Check hourly. Script or executable changes always require review."
        bind:checked={skill.source.autoUpdate}
      />
      <Checkbox
        name="source-pinned"
        label="Pin this version"
        description="Pause periodic checks and automatic updates. Manual checks and reviewed updates remain available."
        bind:checked={skill.source.pinned}
      />
    {/if}
    <SkillDestinations bind:skill {workers} />
    <Disclosure>
      {#snippet summary()}<h3 class="text-base font-medium text-balance">Machine overrides</h3>{/snippet}
      <SkillOverrides class="pt-4" bind:skill {workers} />
    </Disclosure>
    <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
      Save and sync approves these files for the selected computers. Canopy does not run installers or skill scripts
      during sync.
    </p>
    <div class="flex flex-wrap gap-2">
      <Button type="submit" variant="primary" loading={busy} disabled={!uploadReady}>Save and sync</Button><Button
        onclick={oncancel}>Cancel</Button
      >
    </div>
  </fieldset>
</form>
