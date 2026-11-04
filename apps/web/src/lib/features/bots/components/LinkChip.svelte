<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { safeHref } from "#lib/shared/ui/markdown/safe-url.ts";
  import type { LinkView } from "../model.ts";

  /** A link a bot posted (pull request, issue, commit, web page) as a compact chip; unsafe URLs stay text. */
  let { link, class: className }: { link: LinkView; class?: ClassValue } = $props();

  const icons: Record<LinkView["kind"], IconName> = {
    pull_request: "code-bracket",
    issue: "exclamation-circle",
    commit: "link",
    web: "globe-alt",
  };

  const href = $derived(safeHref(link.url));
  const subtitle = $derived(link.subtitle ?? (href ? new URL(href).host : undefined));
</script>

<svelte:element
  this={href ? "a" : "span"}
  {href}
  target={href ? "_blank" : undefined}
  rel={href ? "noopener noreferrer nofollow" : undefined}
  class={[
    "inline-flex max-w-full min-w-0 items-center gap-2 rounded-lg bg-white py-1.5 pr-2.5 pl-2 text-sm/5 ring-1 ring-zinc-950/10 dark:bg-white/5 dark:ring-white/10",
    href && "focus-ring hover:bg-zinc-50 dark:hover:bg-white/10",
    className,
  ]}
>
  <Icon
    name={icons[link.kind]}
    class={link.kind === "pull_request" ? "text-emerald-600 dark:text-emerald-400" : "fill-zinc-500 dark:fill-zinc-400"}
  />
  <span class="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-100">{link.title}</span>
  {#if subtitle}<span class="shrink-0 text-zinc-500 dark:text-zinc-400">{subtitle}</span>{/if}
  {#if href}<Icon name="arrow-top-right-on-square" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />{/if}
</svelte:element>
