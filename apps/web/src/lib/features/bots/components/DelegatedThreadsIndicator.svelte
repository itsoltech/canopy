<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { avatarRing } from "../avatar-ring.ts";

  let { id, working, pinned = false }: { id: string; working: number | null | undefined; pinned?: boolean } = $props();

  const label = $derived(
    working === null
      ? "Threads unknown"
      : working === 1
        ? "1 thread working"
        : working
          ? `${working} threads working`
          : "",
  );
</script>

<span {id} role="status" class={pinned ? "absolute -bottom-0.5 -left-0.5" : "max-w-full shrink-0"}>
  {#if label}
    <span
      title={pinned ? label : undefined}
      class={pinned
        ? [
            "grid size-5 place-items-center rounded-full",
            avatarRing,
            working === null
              ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              : "bg-cyan-100 text-cyan-950 dark:bg-cyan-950 dark:text-cyan-100",
          ]
        : [
            "flex items-center gap-1 text-sm/5 whitespace-nowrap tabular-nums sm:text-xs/4.5 @max-[9rem]:text-(length:--type-meta) @min-[9rem]:ps-2",
            working === null ? "text-zinc-500 dark:text-zinc-400" : "font-medium text-cyan-800 dark:text-cyan-200",
          ]}
    >
      <Icon
        name={working === null ? "question-mark-circle" : "document-duplicate"}
        tone="inherit"
        size="xs"
        class={pinned ? undefined : "hidden @min-[9rem]:block"}
      />
      <span class={pinned ? "sr-only" : "truncate"}>{label}</span>
    </span>
  {/if}
</span>
