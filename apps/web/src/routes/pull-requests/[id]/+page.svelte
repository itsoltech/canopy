<script lang="ts">
  import { page } from "$app/state";
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import type { github } from "@canopy/contracts";
  import PullRequestSummary from "#lib/features/github/PullRequestSummary.svelte";
  import PullRequestState from "#lib/features/github/PullRequestState.svelte";
  import * as api from "#lib/features/github/api.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { HttpError } from "#lib/shared/http.ts";

  let busy = $state(false);
  let error = $state("");
  let denied = $state(false);

  const read = $derived(
    new SharedRead<github.PullRequestSnapshot>(queries, `GetPullRequest:${page.params.id}`, async () => {
      try {
        const value = await api.pullRequest(page.params.id!);
        denied = false;

        return value;
      } catch (cause) {
        if (cause instanceof HttpError && [403, 404, 409, 412].includes(cause.status)) denied = true;
        throw cause;
      }
    }),
  );

  const data = $derived(denied ? undefined : read.data);
  const thread = $derived(page.url.searchParams.get("thread"));

  async function refresh() {
    if (busy) return;
    busy = true;
    error = "";

    try {
      read.set(await api.pullRequest(page.params.id!, true));
      denied = false;
    } catch (cause) {
      if (cause instanceof HttpError && [403, 404, 409, 412].includes(cause.status)) denied = true;
      error = "Could not load this summary. Check account access and the connection, then retry.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="h-full min-w-0 overflow-y-auto bg-white dark:bg-zinc-950">
  <nav
    aria-label="Pull request"
    class="density-chrome sticky top-0 z-10 flex min-w-0 flex-wrap items-center gap-2 border-b border-zinc-950/10 bg-white px-4 py-2 dark:border-white/10 dark:bg-zinc-950"
  >
    <ButtonLink href={thread ? `/threads/${thread}` : "/"} size="sm">Back to thread</ButtonLink>
    <div class="order-last flex w-full min-w-0 items-center gap-2 sm:order-none sm:w-auto sm:flex-1">
      <p class="min-w-0 truncate text-sm/5">{data?.summary?.ref?.repositoryName} #{data?.summary?.ref?.number}</p>
      {#if data?.summary}<PullRequestState state={data.summary.state} />{/if}
    </div>
    <Button size="sm" onclick={refresh} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</Button>
    {#if data?.summary?.ref}<ButtonLink
        href="https://github.com/{data.summary.ref.repositoryName}/pull/{data.summary.ref.number}"
        target="_blank"
        rel="noreferrer"
        size="sm">Open on GitHub</ButtonLink
      >{/if}
  </nav>
  <main class="mx-auto grid max-w-4xl gap-5 p-4 sm:p-6">
    <p class="border-b border-zinc-950/10 pb-3 font-medium dark:border-white/10">Summary</p>
    {#if error || read.snapshot.error}<Alert
        >{error || "Connect to load this page. Check account access, then retry."}<Button size="sm" onclick={refresh}
          >Retry</Button
        ></Alert
      >{/if}
    {#if data}<PullRequestSummary snapshot={data} />{:else if !read.snapshot.error}<p role="status">
        Loading pull request…
      </p>{/if}
  </main>
</div>
