<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import RepositoryAccessActions from "./RepositoryAccessActions.svelte";
  import * as api from "./api.ts";

  let {
    threadId,
    revision,
    onlinked,
    initialUrl = "",
    class: className,
  }: {
    threadId: string;
    revision: bigint;
    onlinked: (value: github.ThreadPullRequestsResponse) => void;
    initialUrl?: string;
    class?: ClassValue;
  } = $props();

  let url = $state(untrack(() => initialUrl));
  let selection = $state<github.GitHubRepositoryAccountResponse>();
  let accountId = $state("");
  let busy = $state(false);
  let error = $state("");
  let name = $state("");
  const homeId = $derived(splitId(threadId).node ? `${GITHUB_HOME}~${splitId(threadId).node}` : "");

  async function check() {
    busy = true;
    error = "";
    selection = undefined;

    try {
      const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*$/.exec(url.trim());

      if (!match) {
        error = "Enter a GitHub pull request URL.";

        return;
      }

      name = match[1]!;
      const value = await api.repositoryAccount(homeId, name);
      selection = value;
      accountId = value.candidates.some((a) => a.id === value.accountId)
        ? value.accountId
        : value.candidates.length === 1
          ? value.candidates[0]!.id
          : "";
    } catch {
      error = "Could not check repository access. Check the connection, then retry.";
    } finally {
      busy = false;
    }
  }

  async function link() {
    const selected = selection;

    if (!selected || !accountId || busy) return;
    busy = true;
    error = "";

    try {
      if (selected.accountId !== accountId)
        selection = await api.chooseAccount(homeId, name, accountId, selected.revision);
      onlinked(await api.link(threadId, url.trim(), revision));
    } catch {
      error = "Could not link this pull request. Check repository access and refresh before retrying.";
    } finally {
      busy = false;
    }
  }
</script>

<form
  class={["grid min-w-0 gap-3", className]}
  onsubmit={(e) => {
    e.preventDefault();
    void (selection ? link() : check());
  }}
>
  <Input
    name="pull-request-url"
    aria-label="Pull request URL"
    placeholder="https://github.com/owner/repo/pull/123"
    bind:value={url}
    oninput={() => {
      selection = undefined;
      error = "";
    }}
  />
  {#if selection}
    {#if selection.candidates.length > 1}
      <Select
        aria-label="GitHub account"
        bind:value={accountId}
        options={selection.candidates.map((a) => ({ value: a.id, label: a.login }))}
        inline
      />
    {:else if !selection.candidates.length}
      <p role="status" class="text-sm/5 text-zinc-500 dark:text-zinc-400">
        No connected GitHub account can access {name}.
      </p>
      <RepositoryAccessActions {homeId} onconnected={() => void check()} />
    {/if}
  {/if}
  {#if error}<Alert>{error}</Alert>{/if}
  <div>
    <Button type="submit" size="sm" disabled={busy || (!!selection && !accountId)}
      >{busy ? "Checking…" : selection ? "Link pull request" : "Check access"}</Button
    >
  </div>
</form>
