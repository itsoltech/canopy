<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { ui } from "@canopy/contracts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import AccessPicker from "#lib/features/access/AccessPicker.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import TagInput from "#lib/shared/ui/TagInput.svelte";
  import AssignmentSummary from "./AssignmentSummary.svelte";

  let {
    selector = $bindable(),
    workers,
    disabled = [],
    parentSelector,
    class: className,
  }: {
    selector: ui.EnvironmentSelector;
    workers: readonly ui.EnvironmentWorker[];
    disabled?: readonly string[];
    parentSelector?: ui.EnvironmentSelector;
    class?: ClassValue;
  } = $props();

  // Workers of linked computers stay assigned; each computer applies only its own.
  const elsewhere = $derived(selector.workerIds.filter((id) => !workers.some((w) => w.workerId === id)).length);
</script>

<div class={["grid gap-4", className]}>
  <Checkbox
    name="environment-everyone"
    label="All computers"
    description="Includes computers added later."
    bind:checked={selector.everyone}
  />
  {#if !selector.everyone}
    <TagInput label="Include tags" name="include-tags" bind:value={selector.tags} {workers} />
    {#if selector.tags.length > 1}<Field label="Tag matching">
        <Select
          name="tag-matching"
          value={selector.matchAllTags ? "all" : "any"}
          options={[
            { value: "any", label: "Match any tag" },
            { value: "all", label: "Match every tag" },
          ]}
          onchange={(v) => (selector.matchAllTags = v === "all")}
        />
      </Field>{/if}
    {#if workers.length}
      <AccessPicker
        label="Specific computers"
        description="Chosen computers get it even without matching tags."
        noun="computers"
        icon="computer-desktop"
        allowAll={false}
        options={workers.map((w) => ({ id: w.workerId, name: w.name, online: w.online }))}
        ids={selector.workerIds}
        onchange={(next) => (selector.workerIds = [...next.ids])}
      />
      {#if elsewhere}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Also assigned to {elsewhere}
          {elsewhere === 1 ? "worker" : "workers"} on linked computers. Change those there.
        </p>{/if}
    {/if}
  {/if}
  <TagInput
    label="Exclude tags"
    name="exclude-tags"
    bind:value={selector.excludeTags}
    {workers}
    description="Exclusions always win, including for specific computers."
  />
  <AssignmentSummary {selector} {workers} {disabled} {parentSelector} />
</div>
