<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    label,
    name,
    value = $bindable([]),
    suggestions = [],
    description,
    class: className,
  }: {
    label: string;
    name: string;
    value?: string[];
    suggestions?: string[];
    description?: string;
    class?: ClassValue;
  } = $props();

  const split = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  let text = $state(untrack(() => value.join(", ")));

  $effect(() => {
    if (JSON.stringify(value) !== JSON.stringify(split(text))) text = value.join(", ");
  });
</script>

<div class={["grid gap-2", className]}>
  <Field {label} {description}>
    <Input
      {name}
      bind:value={text}
      oninput={(e) => {
        text = e.currentTarget.value;
        value = split(text);
      }}
      placeholder="Separate tags with commas"
    />
  </Field>
  {#if suggestions.length}
    <div class="flex flex-wrap gap-1.5 text-base sm:text-sm" aria-label="Suggested tags">
      {#each suggestions.filter((tag) => !value.includes(tag)).slice(0, 8) as tag (tag)}
        <Button size="sm" variant="ghost" onclick={() => (value = [...value, tag])}>
          + {tag}
        </Button>
      {/each}
    </div>
  {/if}
</div>
