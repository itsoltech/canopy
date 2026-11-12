<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
  import { pullRequestPickerItems, type PullRequestPickerItem } from "@canopy/domain/github-pr-picker";
  import type { ClassValue } from "svelte/elements";
  import Combobox from "#lib/shared/ui/Combobox.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
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
  let accessUrl = $state("");
  let epoch = 0;
  const homeId = $derived(splitId(threadId).node ? `${GITHUB_HOME}~${splitId(threadId).node}` : "");

  const items = $derived(pullRequestPickerItems(query, data));

  $effect(() => {
    const search = query,
      all = filter === "all",
      id = threadId;

    void retry;
    const current = ++epoch;
    loading = true;
    error = "";
    accessUrl = "";
    data = untrack(() => data && { ...data, items: [], nextCursor: "" });

    const timer = setTimeout(
      () => {
        void api
          .repositoryPullRequests(id, search.trim().startsWith("https://") ? "" : search, all)
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
        query.trim().startsWith("https://") ? "" : query,
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

  async function link(item: PullRequestPickerItem) {
    if (busy || item.linked) return;
    const current = epoch;
    busy = true;
    error = "";
    accessUrl = "";

    try {
      const value = await api.link(threadId, item.url, revision);
      onlinked(value);

      if (!item.pr && current === epoch) {
        query = "";
        retry++;
      } else if (current === epoch && data)
        data = {
          ...data,
          items: data.items.map((pr) => (pr.number === item.pr?.number ? { ...pr, linked: true } : pr)),
        };
    } catch {
      error = "Could not link this pull request. Refresh the list, then retry.";

      if (!item.pr && current === epoch) accessUrl = item.url;
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
    "flex max-h-[min(26rem,var(--float-available-height,26rem))] min-h-0 flex-col in-data-sheet:max-h-[70dvh]",
    className,
  ]}
>
  <div class="flex min-w-0 shrink-0 items-center gap-2 border-b border-zinc-950/5 px-2.5 py-1 dark:border-white/8">
    <p
      class="min-w-0 flex-1 truncate text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400"
      title={data?.repositoryName}
    >
      {data?.repositoryName || "Pull requests"}
    </p>
    {#if data?.selection && data.selection.candidates.length > 1}
      <div class="max-w-28 min-w-0 shrink text-sm/5 sm:text-xs/4">
        <Select
          inline
          aria-label="GitHub account"
          style="max-width: 100%"
          title={data.selection.candidates.find((account) => account.id === data?.selection?.accountId)?.login}
          value={data.selection.accountId}
          options={data.selection.candidates.map((a) => ({ value: a.id, label: a.login }))}
          disabled={busy || loading}
          onchange={(id) => void choose(id)}
        />
      </div>
    {/if}
    <div class="shrink-0">
      <SegmentedChoice
        label="Pull request state"
        bind:value={filter}
        options={[
          { value: "open", label: "Open" },
          { value: "all", label: "All" },
        ]}
      />
    </div>
  </div>
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
      placeholder="Search or paste a link"
      {items}
      key={(item) => item.key}
      text={(item) => item.label}
      disabled={(item) => busy || item.linked}
      onselect={(item) => void link(item)}
      class="min-h-0 flex-1"
    >
      {#snippet option(item)}
        {#if item.pr}<RepositoryPullRequestRow pr={item.pr} />
        {:else}<span class="flex min-w-0 items-center gap-2">
            <Icon name="link" /><span class="min-w-0 truncate" title={item.label}>{item.label}</span>
          </span>{/if}
      {/snippet}
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
          size="sm">Manage access</ButtonLink
        >
      {:else if data.state === "rate_limited"}<p>Reset: {formatEnglishDateTime(data.retryAt)}</p>{/if}
      {#if data.state !== "not_github"}<Button size="sm" variant="ghost" onclick={() => retry++}>Retry</Button>{/if}
    </div>{/if}
  {#if error}<div role="alert" class="grid gap-2 p-3 text-sm/5 text-amber-700 dark:text-amber-400">
      {error}<Button size="sm" onclick={() => retry++}>Retry</Button>
    </div>{/if}
  {#if data?.nextCursor || accessUrl}
    <div class="grid shrink-0 gap-2 overflow-y-auto border-t border-zinc-950/5 p-2 dark:border-white/8">
      {#if data?.nextCursor}<Button variant="ghost" size="sm" disabled={loading || busy} onclick={() => void more()}
          >Load more</Button
        >{/if}
      {#if accessUrl}
        {#key accessUrl}<LinkPullRequestUrl
            {threadId}
            {revision}
            onlinked={(value) => {
              onlinked(value);
              accessUrl = "";
              retry++;
            }}
            initialUrl={accessUrl}
          />{/key}
      {/if}
    </div>
  {/if}
</div>
