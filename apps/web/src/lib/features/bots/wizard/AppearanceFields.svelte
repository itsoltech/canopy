<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import MascotFace from "../components/MascotFace.svelte";
  import { mascotShapes, mascotColors, type MascotShapeId } from "../mascot.ts";
  import { nameError } from "./draft.ts";
  import ChoiceGrid from "./ChoiceGrid.svelte";
  import CustomColorPicker from "./CustomColorPicker.svelte";
  import MascotPreview from "./MascotPreview.svelte";

  /** Shared by create and edit; no provider/backend dependency. */
  let {
    name = $bindable(""),
    shape = $bindable<MascotShapeId>("round"),
    color = $bindable("#f97316"),
    existingNames,
    originalName,
    submitted = false,
    collapsible = false,
    expanded = $bindable(false),
    disabled = false,
    class: className,
  }: {
    name?: string;
    shape?: MascotShapeId;
    color?: string;
    existingNames: readonly string[];
    originalName?: string | undefined;
    submitted?: boolean;
    collapsible?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();

  let touched = $state(false);
  let customOpen = $state(false);
  const shapes = mascotShapes.map((s) => ({ ...s, value: s.id }));
  const colors = [...mascotColors, { label: "Custom colour", value: "custom" }];
  const selectedColor = $derived(customOpen || !mascotColors.some((c) => c.value === color) ? "custom" : color);
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <div class="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] items-center gap-3">
    <MascotPreview {shape} {color} {name} compact />
    <Field
      label="Name your Bot"
      error={touched || submitted ? nameError(name, existingNames, originalName) : undefined}
    >
      <Input
        bind:value={name}
        name="bot-name"
        maxlength={80}
        placeholder="e.g. Orbit"
        autocomplete="off"
        data-autofocus={!collapsible || undefined}
        {disabled}
        onblur={() => (touched = true)}
      />
    </Field>
  </div>
  {#if collapsible}
    <Disclosure bind:open={expanded}>
      {#snippet summary()}<span class="text-base/6 font-medium sm:text-sm/6">Customise appearance</span>{/snippet}
      <div class="pt-3">{@render choices()}</div>
    </Disclosure>
  {:else}
    {@render choices()}
  {/if}
</div>

{#snippet choices()}
  <div class="grid min-w-0 gap-4">
    <div class="grid gap-2">
      <p class="text-base/6 font-medium sm:text-sm/6">Shape</p>
      <ChoiceGrid
        label="Bot shape"
        options={shapes}
        value={shape}
        onchange={(v) => (shape = v as MascotShapeId)}
        {disabled}
        class="grid-cols-5 sm:grid-cols-7"
      >
        {#snippet children(option, selected)}
          <div
            class={["grid size-10 place-items-center rounded-lg", selected && "ring-2 ring-zinc-950 dark:ring-white"]}
          >
            <MascotFace shape={option.id} color={selected ? color : "#a1a1aa"} class="size-10" />
          </div>
        {/snippet}
      </ChoiceGrid>
    </div>
    <div class="grid gap-2">
      <p class="text-base/6 font-medium sm:text-sm/6">Colour</p>
      <ChoiceGrid
        label="Bot colour"
        options={colors}
        value={selectedColor}
        {disabled}
        class="grid-cols-6 sm:grid-cols-12"
        onchange={(v) => {
          customOpen = v === "custom";
          if (v !== "custom") color = v;
        }}
      >
        {#snippet children(option, selected)}
          <span
            class={[
              "grid size-6 place-items-center rounded-full ring-1 ring-black/10 ring-inset dark:ring-white/15",
              selected && "outline-2 outline-offset-3 outline-zinc-950 dark:outline-white",
              option.value === "custom" ? "custom-swatch" : "bg-(--swatch)",
            ]}
            style:--swatch={option.value === "custom" ? undefined : option.value}
          >
            {#if option.value === "custom"}<Icon name="plus" class="text-white" />{/if}
          </span>
        {/snippet}
      </ChoiceGrid>
      {#if selectedColor === "custom"}<CustomColorPicker bind:value={color} {disabled} />{/if}
    </div>
  </div>
{/snippet}

<style>
  .custom-swatch {
    background: conic-gradient(#ef4444, #fbbf24, #14b8a6, #3b82f6, #8b5cf6, #ec4899, #ef4444);
  }
</style>
