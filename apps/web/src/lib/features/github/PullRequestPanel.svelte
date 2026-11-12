<script lang="ts">
  import { github } from "@canopy/contracts";
  import { create, fromJsonString } from "@bufbuild/protobuf";
  import { tick, untrack } from "svelte";
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
  import RepositoryAccessActions from "./RepositoryAccessActions.svelte";
  import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
  import ReadSkeleton from "./ReadSkeleton.svelte";
  import { providePrCitationTarget } from "./citation-target.ts";
  import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import CiteLayer from "#lib/features/quotes/CiteLayer.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { panelView } from "./panel-view.svelte.ts";
  import PullRequestScroll from "./PullRequestScroll.svelte";

  let {
    id,
    threadId,
    onclose,
    class: className,
  }: {
    id: string;
    threadId?: string;
    onclose?: (() => void | Promise<void>) | undefined;
    class?: ClassValue;
  } = $props();

  let busy = $state(false);
  let denied = $state(false);
  let accessError = $state("");
  let error = $state("");
  const view = $derived(panelView(id));
  const tab = $derived(view.tab);
  let content = $state<HTMLDivElement>();
  let restoring = false;
  let visible = $state(false);
  const prefix = $props.id();
  const drafts = useQuoteDrafts();

  async function beforeinsert() {
    const dialog = content?.closest("dialog");

    const closed = onclose?.();

    // Release the native focus trap before focusing the composer, even if navigation removes the sheet.
    if (onclose && dialog?.open) dialog.close();
    // Navigation restores focus when it completes. Insert only after that restoration.
    await closed;
    await tick();
  }

  providePrCitationTarget(
    async (quote) => {
      if (!threadId || !quote.pullRequest) return;
      const targetThread = threadId;
      await beforeinsert();

      const added = drafts.add(targetThread, {
        text: quote.text,
        source: {
          itemId: "",
          threadId: "",
          kind: "pull_request",
          language: "",
          author: quote.sourceAuthor,
          time: quote.sourceTime,
          pullRequest: quote.pullRequest,
        },
      });

      if (!added) toast("A message can carry up to 20 quotes", { tone: "error" });
    },
    () => Boolean(threadId),
  );

  $effect(() => {
    const changed = () => (visible = document.visibilityState === "visible");
    changed();
    document.addEventListener("visibilitychange", changed);

    return () => document.removeEventListener("visibilitychange", changed);
  });

  $effect(() => {
    if (!visible) return;
    const requestId = id;
    const target = view;
    let revision = target.revision;

    return liveSource(`/api/github/events?id=${encodeURIComponent(requestId)}`, {
      url: () => `/api/github/events?id=${encodeURIComponent(requestId)}&revision=${revision}`,
      onmessage: (text) => {
        const update = fromJsonString(github.PullRequestUpdateSchema, text);
        const changed = !!revision && revision !== update.revision;
        const first = !revision;
        revision = update.revision;
        target.revision = revision;

        if (update.snapshot) untrack(() => read.set(update.snapshot!));

        if (update.gap) invalidations.publish(requestId);
        else if (changed || first)
          for (const resource of update.invalidated) invalidations.publish(`${requestId}:${resource}`);
      },
      ondrop: () => {
        void read.reload().catch(() => {});
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
        accessError = "";

        return value;
      } catch (cause) {
        if (cause instanceof HttpError && cause.status === 403) accessError = cause.message;

        if (cause instanceof HttpError && [403, 404, 409, 412].includes(cause.status)) denied = true;
        throw cause;
      }
    }),
  );

  const data = $derived(denied ? undefined : read.data);

  $effect(() => {
    const active = tab;
    const target = view;
    const loaded = !!data;
    const position = target.scroll[active] ?? 0;
    let current = true;

    if (loaded) {
      restoring = true;
      void tick().then(() => {
        if (!current || !content) return;
        content.scrollTop = position;
        restoring = false;
      });
    }

    return () => {
      current = false;
    };
  });

  async function refresh() {
    if (busy) return;
    busy = true;
    error = "";

    try {
      read.set(await api.pullRequest(id, true));
      invalidations.publish(id);
      denied = false;
      accessError = "";
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 403) accessError = cause.message;

      if (cause instanceof HttpError && [403, 404, 409, 412].includes(cause.status)) denied = true;
      error = "Could not load this summary. Check account access and the connection, then retry.";
    } finally {
      busy = false;
    }
  }

  $effect(() => invalidations.subscribe(`${id}:metadata`, () => void refresh()));

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

<PullRequestScroll
  bind:element={content}
  onscroll={(event) => {
    if (!restoring) view.scroll[tab] = event.currentTarget.scrollTop;
  }}
  class={className}
>
  {#snippet header(compact)}
    {#if data}<PullRequestHeader
        {compact}
        snapshot={data}
        busy={busy || read.snapshot.loading}
        onrefresh={() => void refresh()}
        onunlink={threadId ? () => void unlink() : undefined}
        {onclose}
        oncontext={threadId ? (action) => void prepare(action) : undefined}
      />{:else if !read.snapshot.error}<div class="border-b border-divider px-4">
        <ReadSkeleton header rows={0} />
      </div>{/if}
  {/snippet}
  {#snippet tabs()}<PullRequestTabs bind:value={() => tab, (value) => view.select(value)} {prefix} />{/snippet}
  <div
    role="tabpanel"
    id={`${prefix}-${tab}-panel`}
    aria-labelledby={`${prefix}-${tab}-tab`}
    class={["min-w-0", tab === "summary" ? "p-4" : "px-4 pb-4"]}
  >
    {#if error || read.snapshot.error}<Alert class="mb-4"
        >{accessError || error || "Connect to load this page. Check account access, then retry."}<Button
          size="sm"
          variant="ghost"
          onclick={refresh}>Retry</Button
        ></Alert
      >{/if}
    {#if accessError}<RepositoryAccessActions
        homeId={splitId(id).node ? `${GITHUB_HOME}~${splitId(id).node}` : ""}
        onconnected={() => void refresh()}
      />{/if}
    {#if data?.detail}<p role="status" class="mb-4 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {data.detail}
        {data.stale ? `Last verified ${formatDateTime(data.summary?.verifiedAt)}.` : ""}
        <Button size="sm" variant="ghost" disabled={busy} onclick={refresh}>Retry</Button>
      </p>{/if}
    {#if data}
      {#key `${data.accountId}:${data.accessRevision}:${id}`}
        <div hidden={tab !== "summary"}><PullRequestSummary snapshot={data} /></div>
        {#if view.visited.includes("timeline")}<div hidden={tab !== "timeline"}>
            <PullRequestTimeline {id} snapshot={data} />
          </div>{/if}
        {#if view.visited.includes("code")}<div hidden={tab !== "code"}><PullRequestCode snapshot={data} /></div>{/if}
      {/key}
      {#if tab !== "code"}{#key `${data.accountId}:${id}`}<CommentComposer snapshot={data} class="mt-5" />{/key}{/if}
    {:else if !read.snapshot.error}<ReadSkeleton />{/if}
  </div>
</PullRequestScroll>
{#if threadId}<CiteLayer {threadId} root={content} {beforeinsert} />{/if}
