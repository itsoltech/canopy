<script lang="ts">
  import type { Timestamp } from "@bufbuild/protobuf/wkt";
  import type { PullRequestLook } from "@canopy/domain/github-pr";
  import type { ClassValue } from "svelte/elements";
  import { safeHref } from "@canopy/domain/markdown";
  import { formatAge, formatDateTime } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import CheckStateIcon from "./CheckStateIcon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import GitHubAvatar from "./GitHubAvatar.svelte";

  let {
    author,
    look,
    time,
    url = "",
    avatarUrl = "",
    pullRequestId = "",
    withAvatar = false,
    class: className,
  }: {
    author: string;
    look: PullRequestLook;
    time?: Timestamp | undefined;
    url?: string;
    avatarUrl?: string;
    pullRequestId?: string;
    withAvatar?: boolean;
    class?: ClassValue;
  } = $props();

  const age = $derived(formatAge(time, clock.now));
  const relative = $derived(age ? (age === "now" ? "now" : `${age} ago`) : "");
</script>

<div class={["flex min-w-0 items-center gap-2 text-sm/5 sm:text-xs/5", className]}>
  {#if withAvatar}<GitHubAvatar login={author} url={avatarUrl} {pullRequestId} compact />{/if}
  <p class="min-w-0 truncate font-medium" title={author}>{author || "GitHub"}</p>
  <span class="shrink-0" {@attach tooltip(look.label)}><CheckStateIcon {look} /></span>
  {#if relative}<a
      href={safeHref(url)}
      target="_blank"
      rel="noreferrer"
      class="ml-auto shrink-0 text-zinc-500 hover:underline dark:text-zinc-400"
      {@attach tooltip(formatDateTime(time) || "Open on GitHub")}
      aria-label={`${relative}. ${formatDateTime(time)}`}
    >
      {relative}
    </a>{/if}
</div>
