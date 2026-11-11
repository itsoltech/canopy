<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import { HttpError } from "#lib/shared/http.ts";
  import { formatDateTime } from "#lib/shared/format.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import PullRequestHeader from "./PullRequestHeader.svelte";
  import PullRequestSummary from "./PullRequestSummary.svelte";
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
    />{/if}
  <div class="border-b border-zinc-950/5 bg-surface px-4 py-2 dark:border-white/10">
    <SegmentedChoice label="Pull request view" value="summary" options={[{ value: "summary", label: "Summary" }]} />
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
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
    {#if data}<PullRequestSummary snapshot={data} />{:else if !read.snapshot.error}<p
        role="status"
        class="text-sm text-zinc-500"
      >
        Loading pull request…
      </p>{/if}
  </div>
</div>
