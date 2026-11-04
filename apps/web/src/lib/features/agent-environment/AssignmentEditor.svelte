<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { ui } from "@canopy/contracts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import TagInput from "./TagInput.svelte";

  let {
    selector = $bindable(),
    workers,
    class: className,
  }: {
    selector: ui.EnvironmentSelector;
    workers: readonly ui.EnvironmentWorker[];
    class?: ClassValue;
  } = $props();

  const tags = $derived([...new Set(workers.flatMap((w) => [...w.automaticTags, ...w.manualTags]))].sort());
</script>

<div class={["grid gap-4", className]}>
  <Checkbox
    name="environment-everyone"
    label="Every computer"
    description="Includes computers added later."
    bind:checked={selector.everyone}
  />
  {#if !selector.everyone}
    <TagInput label="Include tags" name="include-tags" bind:value={selector.tags} suggestions={tags} />
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
    <Disclosure>
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
      </div>
    </Disclosure>
  {/if}
  <TagInput
    label="Exclude tags"
    name="exclude-tags"
    bind:value={selector.excludeTags}
    suggestions={tags}
    description="Exclusions always win, including for specific computers."
  />
</div>
