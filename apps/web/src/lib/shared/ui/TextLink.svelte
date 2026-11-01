<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue, HTMLAnchorAttributes } from "svelte/elements";

  /** A link inside running text (underlined, the text's size). */
  type Props = Omit<HTMLAnchorAttributes, "class" | "children"> & { href: string; class?: ClassValue; children: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<a
  class={[
    "font-medium text-zinc-950 underline decoration-zinc-950/30 underline-offset-2 focus-ring hover:decoration-zinc-950 dark:text-white dark:decoration-white/30 dark:hover:decoration-white",
    className,
  ]}
  {...rest}>{@render children()}</a
>
