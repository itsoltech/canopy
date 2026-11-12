<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
  import type { ClassValue } from "svelte/elements";
  import Combobox from "#lib/shared/ui/Combobox.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { formatEnglishDateTime } from "#lib/shared/format.ts";
  import ConnectGitHub from "./ConnectGitHub.svelte";
  import LinkPullRequestUrl from "./LinkPullRequestUrl.svelte";
  import RepositoryPullRequestRow from "./RepositoryPullRequestRow.svelte";
  import * as api from "./api.ts";

  let {
    threadId,
    revision,
    onlinked,
    class: className,
  }: {
    threadId: string;
    revision: bigint;
    onlinked: (value: github.ThreadPullRequestsResponse) => void;
    class?: ClassValue;
  } = $props();
  let query = $state("");
  let filter = $state("open");
  let data = $state<github.RepositoryPullRequestsResponse>();
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");
  let retry = $state(0);
  let manual = $state(false);
  let epoch = 0;
  const homeId = $derived(splitId(threadId).node ? `${GITHUB_HOME}~${splitId(threadId).node}` : "");
  const directUrl = $derived(
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(query.trim())
      ? query.trim()
      : /^#?[1-9][0-9]*$/.test(query.trim()) && data?.repositoryName
        ? `https://github.com/${data.repositoryName}/pull/${query.trim().replace(/^#/, "")}`
        : "",
  );

  $effect(() => {
    const search = query,
      all = filter === "all",
      id = threadId;
    retry;
    const current = ++epoch;
    loading = true;
    error = "";
    data = untrack(() => data && { ...data, items: [], nextCursor: "" });
    const timer = setTimeout(
      () => {
        void api
          .repositoryPullRequests(id, /^https:\/\//.test(search.trim()) ? "" : search, all)
          .then((value) => {
            if (current === epoch) data = value;
          })
          .catch(() => {
            if (current === epoch) error = "Could not load pull requests. Check the connection, then retry.";
          })
          .finally(() => {
            if (current === epoch) loading = false;
          });
      },
      search ? 250 : 0,
    );

    return () => {
      clearTimeout(timer);
      if (epoch === current) epoch++;
    };
  });

  async function more() {
    if (!data?.nextCursor || loading || busy) return;
    const current = epoch,
      previous = data;
    loading = true;
    try {
      const page = await api.repositoryPullRequests(
        threadId,
        /^https:\/\//.test(query.trim()) ? "" : query,
        filter === "all",
        previous.nextCursor,
      );
      if (current === epoch)
        data = {
          ...page,
          items:
            page.state === "ready"
              ? [...previous.items, ...page.items.filter((p) => !previous.items.some((old) => old.number === p.number))]
              : [],
        };
    } catch {
      if (current === epoch) error = "Could not load more pull requests. Retry the list.";
    } finally {
      if (current === epoch) loading = false;
    }
  }

  async function link(pr: github.RepositoryPullRequest) {
    if (!data || busy || pr.linked) return;
    const current = epoch;
    busy = true;
    error = "";
    try {
      const value = await api.link(threadId, `https://github.com/${data.repositoryName}/pull/${pr.number}`, revision);
      onlinked(value);
      if (current === epoch && data)
        data = {
          ...data,
          items: data.items.map((item) => (item.number === pr.number ? { ...item, linked: true } : item)),
        };
    } catch {
      error = "Could not link this pull request. Refresh the list, then retry.";
    } finally {
      busy = false;
    }
  }

  async function choose(accountId: string) {
    const selection = data?.selection;
    if (!selection || busy) return;
    busy = true;
    try {
      await api.chooseAccount(homeId, selection.repositoryName, accountId, selection.revision);
      retry++;
    } catch {
      error = "Could not choose this account. Check repository access, then retry.";
    } finally {
      busy = false;
    }
  }
</script>

<div
  class={[
    "flex max-h-[min(32rem,var(--float-available-height,32rem))] min-h-0 flex-col in-data-sheet:max-h-[70dvh]",
    className,
  ]}
>
  <div
    class="flex min-w-0 shrink-0 items-center justify-between gap-2 border-b border-zinc-950/5 p-2 dark:border-white/8"
  >
    <p class="min-w-0 truncate text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400" title={data?.repositoryName}>
      {data?.repositoryName || "Pull requests"}
    </p>
    <SegmentedChoice
      label="Pull request state"
      bind:value={filter}
      options={[
        { value: "open", label: "Open" },
        { value: "all", label: "All" },
      ]}
    />
  </div>
  {#if data?.selection && (data.selection.candidates.length > 1 || data.state === "choose_account")}
    <div class="min-w-0 border-b border-zinc-950/5 px-2 py-1 dark:border-white/8">
      <Select
        inline
        aria-label="GitHub account"
        value={data.selection.accountId}
        options={data.selection.candidates.map((a) => ({ value: a.id, label: a.login }))}
        placeholder="Choose an account"
        disabled={busy || loading}
        onchange={(id) => void choose(id)}
      />
    </div>
  {/if}
  <div
    class="flex min-h-0 flex-1 flex-col"
    onscrollcapture={(event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.scrollHeight - target.scrollTop - target.clientHeight < 100)
        void more();
    }}
  >
    <Combobox
      inline
      autofocus
      filter={false}
      bind:query
      label="Find a pull request"
      name="pull-request-search"
      placeholder="#123, title, branch, author or URL"
      items={data?.items ?? []}
      key={(pr) => String(pr.number)}
      text={(pr) => `#${pr.number} ${pr.title}`}
      disabled={(pr) => busy || pr.linked}
      onselect={(pr) => void link(pr)}
      class="min-h-0 flex-1"
    >
      {#snippet option(pr)}<RepositoryPullRequestRow {pr} />{/snippet}
      {#snippet empty()}
        {#if loading}<div role="status" aria-label="Loading pull requests…" class="grid gap-3 text-left">
            {#each [1, 2, 3] as row (row)}<div class="grid gap-1">
                <Skeleton class="h-4 w-4/5" /><Skeleton class="h-3 w-3/5" />
              </div>{/each}
          </div>{:else if data?.state === "ready"}{data.nextCursor
            ? "Load more to find pull requests"
            : query
              ? "No matching pull requests"
              : filter === "open"
                ? "No open pull requests"
                : "No pull requests yet"}{/if}
      {/snippet}
    </Combobox>
  </div>
  {#if loading && data?.items.length}<p role="status" class="px-3 py-2 text-sm text-zinc-500">
      Loading pull requests…
    </p>{/if}
  {#if data?.state && data.state !== "ready"}<div
      class="grid gap-2 border-t border-zinc-950/5 p-3 text-sm/5 sm:text-xs/4 dark:border-white/8"
    >
      <p role="status" class="text-zinc-500 dark:text-zinc-400">{data.detail}</p>
      {#if data.state === "account_required"}<ConnectGitHub
          {homeId}
          configured={data.configured}
          onconnected={() => retry++}
        />
      {:else if data.state === "installation_required"}<ButtonLink
          href={data.installUrl || "/settings/github"}
          target={data.installUrl ? "_blank" : undefined}
          rel="noreferrer"
          size="sm">Manage repositories</ButtonLink
        >
      {:else if data.state === "rate_limited"}<p>Reset: {formatEnglishDateTime(data.retryAt)}</p>{/if}
      {#if data.state !== "not_github"}<Button size="sm" variant="ghost" onclick={() => retry++}>Retry</Button>{/if}
    </div>{/if}
  {#if error}<div role="alert" class="grid gap-2 p-3 text-sm/5 text-amber-700 dark:text-amber-400">
      {error}<Button size="sm" onclick={() => retry++}>Retry</Button>
    </div>{/if}
  <div class="grid shrink-0 gap-2 border-t border-zinc-950/5 p-2 dark:border-white/8">
    {#if data?.nextCursor}<Button variant="ghost" size="sm" disabled={loading || busy} onclick={() => void more()}
        >Load more</Button
      >{/if}
    {#if directUrl || manual || data?.state === "not_github"}
      {#key directUrl}<LinkPullRequestUrl
          {threadId}
          {revision}
          onlinked={(value) => {
            onlinked(value);
            retry++;
          }}
          initialUrl={directUrl}
        />{/key}
    {:else}<Button variant="ghost" size="sm" onclick={() => (manual = true)}>Link by URL</Button>{/if}
  </div>
</div>
