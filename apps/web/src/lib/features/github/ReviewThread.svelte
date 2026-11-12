<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import { safeHref } from "@canopy/domain/markdown";
  import type { ClassValue } from "svelte/elements";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import * as api from "./api.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import ActivityHeader from "./ActivityHeader.svelte";
  import { reviewerLook } from "@canopy/domain/github-pr";
  import CommentComposer from "./CommentComposer.svelte";
  import CommentActions from "./CommentActions.svelte";
  import ThreadResolution from "./ThreadResolution.svelte";
  import { anchorLabel } from "@canopy/domain/github-review";

  let {
    id,
    thread,
    snapshot,
    class: className,
  }: {
    id: string;
    thread: github.PullRequestReviewThread;
    snapshot: github.PullRequestSnapshot;
    class?: ClassValue;
  } = $props();

  let visible = $state(3);
  let current = $state<github.PullRequestReviewThread>();
  let history = $state<github.PullRequestReviewThread[]>([]);
  let error = $state("");
  let busy = $state(false);
  let generation = 0;

  const data = $derived(
    current ? { ...thread, comments: current.comments, repliesCursor: current.repliesCursor } : thread,
  );

  const comments = $derived([
    ...new Map(
      [...history.flatMap((page) => page.comments), ...data.comments].map((comment) => [comment.id, comment]),
    ).values(),
  ]);

  const head = $derived(snapshot.summary?.headSha);

  $effect(() => {
    void head;
    current = undefined;
    history = [];
    visible = 3;
    error = "";
    busy = false;
    generation++;
  });

  $effect(() => {
    const first = thread;
    untrack(() => {
      if (history.length) history = [first, ...history.slice(1)];
    });
  });

  async function more() {
    if (busy) return;

    if (visible < comments.length) {
      visible = comments.length;

      return;
    }

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
        visible = comments.length;
        error = "";
      }
    } catch {
      if (version === generation) error = "Could not load replies. Refresh, then retry.";
    } finally {
      if (version === generation) busy = false;
    }
  }
</script>

<div
  class={[
    "grid min-w-0 gap-3 rounded-lg border border-zinc-950/10 bg-zinc-500/3 p-3 dark:border-white/10 dark:bg-white/3",
    className,
  ]}
>
  <div class="flex min-w-0 items-center gap-2 text-sm/5 sm:text-xs/5">
    <Icon name="code-bracket" />
    <p class="min-w-0 flex-1 truncate font-mono" title={`${data.path} · ${anchorLabel(data)}`}>
      {data.path} · {anchorLabel(data)}
    </p>
    <span {@attach tooltip(data.resolved ? "Resolved" : "Unresolved")}
      ><Icon
        name={data.resolved ? "check-circle" : "chat-bubble-left"}
        label={data.resolved ? "Resolved" : "Unresolved"}
      /></span
    >
    {#if data.outdated}<span {@attach tooltip("Outdated")}><Icon name="clock" label="Outdated" /></span>{/if}
  </div>
  {#each comments.slice(0, visible) as comment, index (comment.id)}<div
      class={[
        "grid min-w-0 gap-2 [&>div]:[overflow-wrap:anywhere]",
        index > 0 && "ml-3 border-l border-zinc-950/10 pl-3 dark:border-white/10",
      ]}
    >
      <ActivityHeader
        withAvatar={index > 0}
        avatarUrl={comment.avatarUrl}
        pullRequestId={id}
        author={comment.author}
        time={comment.createdAt}
        url={safeHref(comment.url)}
        look={reviewerLook("commented")}
      />
      <Markdown text={comment.body} class="min-w-0" />
      <CommentActions {snapshot} {comment} kind="review" />
    </div>{/each}
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="flex gap-2">
    {#if visible < comments.length || data.repliesCursor}<Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onclick={more}>{busy ? "Loading replies…" : "Show more replies"}</Button
      >{/if}
  </div>
  {#key `${snapshot.accountId}:${thread.id}`}<CommentComposer {snapshot} resourceId={thread.id} />{/key}
  {#key `${snapshot.accountId}:${thread.id}:resolve`}<ThreadResolution {snapshot} thread={data} />{/key}
</div>
