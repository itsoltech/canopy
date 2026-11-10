<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { ui } from "@canopy/contracts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
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
    {#if workers.length}<Disclosure>
        {#snippet summary()}<div class="text-base font-medium sm:text-sm">
            Or choose specific computers ({selector.workerIds.length})
          </div>{/snippet}
        <div class="grid max-h-52 gap-3 overflow-auto py-3 pl-6">
          {#each workers as worker (worker.workerId)}
            <Checkbox
              name="assign-{worker.workerId}"
              label={worker.name}
              bind:checked={
                () => selector.workerIds.includes(worker.workerId),
                (on) =>
                  (selector.workerIds = on
                    ? [...selector.workerIds, worker.workerId]
                    : selector.workerIds.filter((id) => id !== worker.workerId))
              }
            />
          {:else}<p class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
              Add a worker to choose a computer.
            </p>{/each}
          {#if elsewhere}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
              Also assigned to {elsewhere}
              {elsewhere === 1 ? "worker" : "workers"} on linked computers. Change those there.
            </p>{/if}
        </div>
      </Disclosure>{/if}
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
