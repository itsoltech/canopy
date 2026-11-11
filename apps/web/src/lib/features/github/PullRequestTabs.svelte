<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let {
    value = $bindable("summary"),
    prefix,
    class: className,
  }: { value?: string; prefix: string; class?: ClassValue } = $props();

  const options = ["summary", "timeline", "code"];

  function keydown(event: KeyboardEvent, index: number) {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

    if (!offset && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    value = options[event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + offset + 3) % 3]!;
    document.getElementById(`${prefix}-${value}-tab`)?.focus();
  }
</script>

<div
  role="tablist"
  aria-label="Pull request view"
  class={["flex gap-1 overflow-x-auto border-b border-zinc-950/5 px-4 dark:border-white/10", className]}
>
  {#each options as option, i (option)}<button
      type="button"
      role="tab"
      id={`${prefix}-${option}-tab`}
      aria-controls={`${prefix}-${option}-panel`}
      aria-selected={value === option}
      tabindex={value === option ? 0 : -1}
      onclick={() => (value = option)}
      onkeydown={(e) => keydown(e, i)}
      class={[
        "min-h-11 shrink-0 border-b-2 px-3 text-sm font-medium focus-ring sm:min-h-9",
        value === option
          ? "border-zinc-700 text-zinc-950 dark:border-zinc-300 dark:text-white"
          : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white",
      ]}>{option[0]?.toUpperCase()}{option.slice(1)}</button
    >{/each}
</div>
