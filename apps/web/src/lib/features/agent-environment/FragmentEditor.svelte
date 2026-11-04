<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import AssignmentEditor from "./AssignmentEditor.svelte";
  import AssignmentSummary from "./AssignmentSummary.svelte";

  let {
    fragment = $bindable(),
    workers,
    parentSelector,
    disabled = [],
    index,
    count,
    onmove,
    onremove,
    class: className,
  }: {
    fragment: ui.InstructionFragment;
    workers: readonly ui.EnvironmentWorker[];
    parentSelector?: ui.EnvironmentSelector;
    disabled?: readonly string[];
    index: number;
    count: number;
    onmove: (direction: number) => void;
    onremove: () => void;
    class?: ClassValue;
  } = $props();
</script>

<section class={["grid gap-4", className]} aria-label="Fragment {index + 1}">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-base font-medium text-balance tabular-nums">Fragment {index + 1}</h3>
    <div class="flex flex-wrap gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={index === 0}
        onclick={() => onmove(-1)}
        aria-label="Move fragment {index + 1} up">Move up</Button
      >
      <Button
        size="sm"
        variant="ghost"
        disabled={index === count - 1}
        onclick={() => onmove(1)}
        aria-label="Move fragment {index + 1} down">Move down</Button
      >
      <Button size="sm" variant="ghost" onclick={onremove}>Remove</Button>
    </div>
  </div>
  <Field label="Fragment name"
    ><Input
      name="fragment-name"
      bind:value={fragment.name}
      maxlength={120}
      placeholder="For example, Windows tooling"
    /></Field
  >
  <Field label="Instructions"
    ><Textarea
      name="fragment-content"
      bind:value={fragment.content}
      rows={6}
      placeholder="Write the instructions the agent should follow…"
    /></Field
  >
  <Disclosure>
    {#snippet summary()}<div class="text-base sm:text-sm">
        {fragment.selector ? "Restricted to selected computers" : "Uses the document's assignment"}
      </div>{/snippet}
    <div class="grid gap-4 pt-4">
      <Checkbox
        name="fragment-targeting"
        label="Limit this fragment to tags or computers"
        bind:checked={
          () => Boolean(fragment.selector),
          (on) => (fragment.selector = on ? create(ui.EnvironmentSelectorSchema) : undefined)
        }
      />
      {#if fragment.selector}<AssignmentEditor
          bind:selector={fragment.selector}
          {workers}
          {parentSelector}
          {disabled}
        />
      {:else}<AssignmentSummary selector={parentSelector} {workers} {disabled} />{/if}
    </div>
  </Disclosure>
</section>
