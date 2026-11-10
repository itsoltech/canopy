<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import { safeHref } from "@canopy/domain/markdown";
  import type { ClassValue } from "svelte/elements";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import * as api from "./api.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    id,
    thread,
    class: className,
  }: { id: string; thread: github.PullRequestReviewThread; class?: ClassValue } = $props();

  let open = $state(false);
  let current = $state<github.PullRequestReviewThread>();
  let history = $state<github.PullRequestReviewThread[]>([]);
  let error = $state("");
  let busy = $state(false);
  let generation = 0;
  const data = $derived(current ?? thread);

  $effect(() => {
    void thread;
    current = undefined;
    history = [];
    error = "";
    busy = false;
    generation++;
  });

  async function more() {
    if (busy) return;
    busy = true;
    const version = generation;
    const previous = data;

    try {
      const value = await api.page(
        "reviews",
        github.PullRequestReviewThreadsPageSchema,
        create(github.PullRequestPageRequestSchema, {
          pullRequestId: id,
          resourceId: thread.id,
          cursor: data.repliesCursor,
        }),
      );

      if (version === generation && value.threads[0]) {
        history = [...history, previous];
        current = value.threads[0];
        error = "";
      }
    } catch {
      if (version === generation) error = "Could not load replies. Refresh, then retry.";
    } finally {
      if (version === generation) busy = false;
    }
  }
</script>

<div class={["grid min-w-0 gap-2 border-b border-zinc-950/5 pb-3 dark:border-white/10", className]}>
  <button
    type="button"
    class="flex min-w-0 items-center gap-2 text-left text-sm/5 focus-ring sm:text-xs/5"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Icon name={open ? "chevron-down" : "chevron-right"} />
    <p class="min-w-0 flex-1 truncate font-mono" title={data.path}>{data.path}:{data.line || "…"}</p>
    <span {@attach tooltip(data.resolved ? "Resolved" : "Unresolved")}
      ><Icon
        name={data.resolved ? "check-circle" : "chat-bubble-left"}
        label={data.resolved ? "Resolved" : "Unresolved"}
      /></span
    >
    {#if data.outdated}<span {@attach tooltip("Outdated")}><Icon name="clock" label="Outdated" /></span>{/if}
  </button>
  {#if open}
    {#each data.comments as comment (comment.id)}<div class="grid gap-2 pl-4">
        <a href={safeHref(comment.url)} target="_blank" rel="noreferrer" class="text-sm font-medium hover:underline"
          >{comment.author}</a
        >
        <Markdown text={comment.body} />
      </div>{/each}
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="flex gap-2">
      {#if history.length}<Button
          variant="ghost"
          disabled={busy}
          onclick={() => {
            current = history.at(-1);
            history = history.slice(0, -1);
          }}>Previous replies</Button
        >{/if}
      {#if data.repliesCursor}<Button variant="ghost" disabled={busy} onclick={more}>Next replies</Button>{/if}
    </div>
  {/if}
</div>
