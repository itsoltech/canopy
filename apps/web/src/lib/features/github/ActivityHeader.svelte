<script lang="ts">
  import type { Timestamp } from "@bufbuild/protobuf/wkt";
  import type { PullRequestLook } from "@canopy/domain/github-pr";
  import type { ClassValue } from "svelte/elements";
  import { safeHref } from "@canopy/domain/markdown";
  import { formatAge, formatDateTime } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { toneClasses } from "./presentation.ts";

  let {
    author,
    look,
    time,
    url = "",
    class: className,
  }: {
    author: string;
    look: PullRequestLook;
    time?: Timestamp | undefined;
    url?: string;
    class?: ClassValue;
  } = $props();

  const age = $derived(formatAge(time, clock.now));
</script>

<div class={["flex min-w-0 items-center gap-2 text-sm/5 sm:text-xs/5", className]}>
  <p class="min-w-0 truncate font-medium" title={author}>{author || "GitHub"}</p>
  <span class={toneClasses[look.tone]} {@attach tooltip(look.label)}
    ><Icon name={look.icon} label={look.label} tone="inherit" /></span
  >
  <a
    href={safeHref(url)}
    target="_blank"
    rel="noreferrer"
    class="ml-auto shrink-0 text-zinc-500 hover:underline dark:text-zinc-400"
    {@attach tooltip(formatDateTime(time) || "Open on GitHub")}
    aria-label={`${age === "now" ? "Now" : `${age} ago`}. ${formatDateTime(time)}`}
  >
    {age === "now" ? "now" : `${age} ago`}
  </a>
</div>
