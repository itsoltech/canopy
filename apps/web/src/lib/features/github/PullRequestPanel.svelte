<script lang="ts">
  import { github } from "@canopy/contracts";
  import { create, fromJsonString } from "@bufbuild/protobuf";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import { HttpError } from "#lib/shared/http.ts";
  import { formatDateTime } from "#lib/shared/format.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import PullRequestTabs from "./PullRequestTabs.svelte";
  import PullRequestTimeline from "./PullRequestTimeline.svelte";
  import PullRequestCode from "./PullRequestCode.svelte";
  import { liveSource } from "#lib/shared/live-source.ts";
  import { contextDraft } from "./context-draft.svelte.ts";
  import { invalidations } from "./invalidations.ts";
  import PullRequestHeader from "./PullRequestHeader.svelte";
  import PullRequestSummary from "./PullRequestSummary.svelte";
  import CommentComposer from "./CommentComposer.svelte";
  import * as api from "./api.ts";

  let {
    id,
    threadId,
    onclose,
    class: className,
  }: { id: string; threadId?: string; onclose?: (() => void) | undefined; class?: ClassValue } = $props();

  let busy = $state(false);
  let denied = $state(false);
  let error = $state("");
  let tab = $state("summary");
  let visible = $state(false);
  const prefix = $props.id();

  $effect(() => {
    const changed = () => (visible = document.visibilityState === "visible");
    changed();
    document.addEventListener("visibilitychange", changed);

    return () => document.removeEventListener("visibilitychange", changed);
  });

  $effect(() => {
    if (!visible) return;
    const requestId = id;
    let revision = "";

    return liveSource(`/api/github/events?id=${encodeURIComponent(requestId)}`, {
      url: () => `/api/github/events?id=${encodeURIComponent(requestId)}&revision=${revision}`,
      onmessage: (text) => {
        const update = fromJsonString(github.PullRequestUpdateSchema, text);
        const changed = !!revision && revision !== update.revision;
        revision = update.revision;

        if (update.snapshot) untrack(() => read.set(update.snapshot!));

        if (changed || update.gap) invalidations.publish(requestId);
      },
      ondrop: () => {
        void read.reload().catch(() => {});
      },
      onopen: (reconnected) => {
        if (reconnected) invalidations.publish(requestId);
      },
    });
  });

  async function prepare(action: string) {
    if (!threadId || busy) return;
    busy = true;

    try {
      const context = await api.context(
        create(github.PreparePullRequestContextRequestSchema, { pullRequestId: id, threadId, action }),
      );

      contextDraft.pending = { threadId, context };
      onclose?.();
    } catch {
      error = "Could not prepare PR context. Check access and attachment limits, then retry.";
    } finally {
      busy = false;
    }
  }

  const read = $derived(
    new SharedRead<github.PullRequestSnapshot>(queries, `GetPullRequest:${id}`, async () => {
      try {
        const value = await api.pullRequest(id);
        denied = false;

        return value;
      } catch (cause) {
        if (cause instanceof HttpError && [403, 404, 409, 412].includes(cause.status)) denied = true;
        throw cause;
      }
    }),
  );

  const data = $derived(denied ? undefined : read.data);

  async function refresh() {
    if (busy) return;
    busy = true;
    error = "";

    try {
      read.set(await api.pullRequest(id, true));
      denied = false;
    } catch (cause) {
      if (cause instanceof HttpError && [403, 404, 409, 412].includes(cause.status)) denied = true;
      error = "Could not load this summary. Check account access and the connection, then retry.";
    } finally {
      busy = false;
    }
  }

  async function unlink() {
    if (!threadId || busy) return;
    busy = true;

    try {
      const current = await api.pullRequests(threadId);
      await api.unlink(threadId, id, current.revision);
      onclose?.();
    } catch {
      error = "Could not unlink this pull request. Refresh, then retry.";
    } finally {
      busy = false;
    }
  }
</script>

<div class={["flex h-full min-h-0 min-w-0 flex-col bg-surface", className]}>
  {#if data}<PullRequestHeader
      snapshot={data}
      {busy}
      onrefresh={() => void refresh()}
      onunlink={threadId ? () => void unlink() : undefined}
      {onclose}
      oncontext={threadId ? (action) => void prepare(action) : undefined}
    />{/if}
  <PullRequestTabs bind:value={tab} {prefix} />
  <div
    role="tabpanel"
    id={`${prefix}-${tab}-panel`}
    aria-labelledby={`${prefix}-${tab}-tab`}
    class={["min-h-0 flex-1 scroll-stable overflow-y-auto overscroll-contain", tab === "summary" ? "p-4" : "px-4 pb-4"]}
  >
    {#if error || read.snapshot.error}<Alert class="mb-4"
        >{error || "Connect to load this page. Check account access, then retry."}<Button
          size="sm"
          variant="ghost"
          onclick={refresh}>Retry</Button
        ></Alert
      >{/if}
    {#if data?.detail}<p role="status" class="mb-4 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {data.detail}
        {data.stale ? `Last verified ${formatDateTime(data.summary?.verifiedAt)}.` : ""}
      </p>{/if}
    {#if data}
      {#key data.accountId}{#if tab === "summary"}<PullRequestSummary
            snapshot={data}
          />{:else if tab === "timeline"}<PullRequestTimeline {id} snapshot={data} />{:else}<PullRequestCode
            snapshot={data}
          />{/if}{/key}
      {#if tab !== "code"}{#key `${data.accountId}:${id}`}<CommentComposer snapshot={data} class="mt-5" />{/key}{/if}
    {:else if !read.snapshot.error}<p role="status" class="text-sm text-zinc-500">Loading pull request…</p>{/if}
  </div>
</div>
