<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Combobox from "#lib/shared/ui/Combobox.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let {
    label,
    name,
    value = $bindable([]),
    workers = [],
    automatic = true,
    description,
    class: className,
  }: {
    label: string;
    name: string;
    value?: string[];
    workers?: readonly ui.EnvironmentWorker[];
    automatic?: boolean;
    description?: string;
    class?: ClassValue;
  } = $props();

  let query = $state("");

  const candidates = $derived.by(() => {
    const counts = new Map<string, number>();

    for (const worker of workers) {
      for (const tag of new Set([...worker.manualTags, ...(automatic ? worker.automaticTags : [])]))
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }

    for (const tag of value) if (!counts.has(tag)) counts.set(tag, 0);

    const items = [...counts]
      .filter(([tag]) => tag.includes(query.trim().toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => ({ tag, count, create: false }));

    const tag = query.trim().toLowerCase();

    if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag) && !counts.has(tag) && !value.includes(tag))
      items.push({ tag, count: 0, create: true });

    return items;
  });

  function add(tag: string) {
    value = value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag];
    query = "";
  }
</script>

<div class={["grid min-w-0 gap-2", className]}>
  <Field {label} {description}>
    <Combobox
      items={candidates}
      key={(item) => item.tag}
      text={(item) => item.tag}
      filter={false}
      bind:query
      multiple
      selectedKeys={value}
      {name}
      {label}
      placeholder="Find or create a tag…"
      onselect={(item) => add(item.tag)}
      onkeydown={(event) => {
        if (event.key === "Backspace" && !query && value.length) value = value.slice(0, -1);
        if (event.key === "Enter" && !candidates.length) event.preventDefault();
      }}
    >
      {#snippet option(item, state)}
        <div class="flex min-w-0 items-center justify-between gap-3 text-base sm:text-sm">
          <span class="truncate">{item.create ? `Create “${item.tag}”` : item.tag}</span>
          {#if state.selected}<Icon name="check" />{/if}
          <span class="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400"
            >{item.count} {item.count === 1 ? "computer" : "computers"}</span
          >
        </div>
      {/snippet}
      {#snippet empty()}
        {query
          ? "No matching tags. New tags use lowercase letters, digits, dots, hyphens and underscores."
          : "Type to create your first tag."}
      {/snippet}
    </Combobox>
  </Field>
  {#if value.length}
    <div class="flex flex-wrap gap-1.5" aria-label="Selected {label.toLowerCase()}">
      {#each value as tag (tag)}
        <Button
          size="sm"
          variant="secondary"
          aria-label="Remove tag {tag}"
          onclick={() => (value = value.filter((t) => t !== tag))}
        >
          <span class="min-w-0 break-all">{tag}</span><Icon name="x-mark" />
        </Button>
      {/each}
    </div>
  {/if}
</div>
