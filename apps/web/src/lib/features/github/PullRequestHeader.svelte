<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatAge, formatDateTime } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import GitHubAvatar from "./GitHubAvatar.svelte";
  import PullRequestState from "./PullRequestState.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import LifecycleActions from "./LifecycleActions.svelte";
  import MetadataEdit from "./MetadataEdit.svelte";
  import RepositoryAccountSwitch from "./RepositoryAccountSwitch.svelte";
  import PullRequestMenu from "./PullRequestMenu.svelte";
  import PullRequestCompact from "./PullRequestCompact.svelte";

  let {
    snapshot,
    busy = false,
    compact = false,
    onrefresh,
    onunlink,
    onclose,
    oncontext,
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    busy?: boolean;
    compact?: boolean;
    onrefresh: () => void;
    onunlink?: (() => void) | undefined;
    onclose?: (() => void) | undefined;
    oncontext?: ((action: string) => void) | undefined;
    class?: ClassValue;
  } = $props();

  const pr = $derived(snapshot.summary);
  let metadataTitle = $state<string>();
  const ref = $derived(pr?.ref);
  const age = $derived(formatAge(pr?.updatedAt, clock.now));
  const url = $derived(`https://github.com/${ref?.repositoryName}/pull/${ref?.number}`);

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast(message);
    } catch {
      toast("Could not copy. Select the text and copy it manually.", { tone: "error" });
    }
  }
</script>

<header
  class={[
    "density-chrome relative grid min-w-0 gap-2.5 border-b border-zinc-950/10 bg-surface p-4 text-base/5 sm:text-sm/5 dark:border-white/10",
    className,
  ]}
>
  <div inert={compact} class={["grid min-w-0 gap-2.5", compact && "invisible"]}>
    <div class="flex min-w-0 items-center gap-2">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        class="flex min-w-0 flex-1 gap-1 font-medium text-zinc-500 hover:underline dark:text-zinc-400"
        title={`${ref?.repositoryName} #${ref?.number}`}
        ><span class="min-w-0 truncate">{ref?.repositoryName}</span><span
          class="shrink-0 text-zinc-900 dark:text-zinc-100">#{ref?.number}</span
        ></a
      >
      <PullRequestState state={pr?.state ?? ""} />
      <IconButton icon="arrow-path" label="Refresh pull request" loading={busy} size="sm" onclick={onrefresh} />
      <PullRequestMenu {url} number={ref?.number ?? 0} {busy} oncopy={copy} {onrefresh} {onunlink} {oncontext} />
      {#if onclose}<IconButton icon="x-mark" label="Close pull request" size="sm" onclick={onclose} />{/if}
    </div>
    {#if ref}<RepositoryAccountSwitch
        repositoryName={ref.repositoryName}
        accountId={snapshot.accountId}
        disabled={busy}
        onchanged={onrefresh}
      />{/if}
    <div class="relative min-w-0">
      <h2
        class="line-clamp-2 pr-10 text-lg font-semibold text-zinc-950 dark:text-white"
        title={metadataTitle ?? pr?.title}
      >
        {metadataTitle ?? pr?.title}
      </h2>
      {#key `${snapshot.accountId}:${snapshot.accessRevision}:${ref?.id}`}<MetadataEdit
          {snapshot}
          kind="title"
          ondisplay={(value) => (metadataTitle = value?.title)}
          class="[&>button]:absolute [&>button]:top-0 [&>button]:right-0"
        />{/key}
    </div>
    <div class="flex min-w-0 items-center gap-2 text-sm/5 sm:text-xs/5">
      <GitHubAvatar
        pullRequestId={snapshot.summary?.ref?.id}
        url={snapshot.actorAvatars[snapshot.author]}
        login={snapshot.author}
        compact
      />
      <p class="min-w-0 truncate" title={snapshot.author}>{snapshot.author}</p>
      {#if age}<p class="shrink-0 text-zinc-500 dark:text-zinc-400" title={formatDateTime(pr?.updatedAt)}>
          updated {age === "now" ? "now" : `${age} ago`}
        </p>{/if}
    </div>
    <p
      class="truncate font-mono text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
      title={`${snapshot.baseRef} ← ${snapshot.headRef}`}
    >
      {snapshot.baseRef} ← {snapshot.headRef}
    </p>
    <div class="flex flex-wrap items-center justify-between gap-2 text-sm/5 sm:text-xs/5">
      <p class="text-zinc-500 tabular-nums dark:text-zinc-400">
        {snapshot.files} files <span class="ml-1 text-emerald-700 dark:text-emerald-400">+{snapshot.additions}</span>
        <span class="text-rose-700 dark:text-rose-400">−{snapshot.deletions}</span>
      </p>
      <button
        type="button"
        aria-label="Copy checkout command"
        title={`Run in ${ref?.repositoryName}`}
        onclick={() => void copy(`gh pr checkout ${ref?.number}`, "Checkout command copied")}
        class="relative flex items-center gap-2 rounded-md bg-zinc-950/4 px-2 py-1 font-mono focus-ring hover:bg-zinc-950/8 dark:bg-white/5 dark:hover:bg-white/10"
        ><TouchTarget /><code>gh pr checkout {ref?.number}</code><Icon name="copy" size="sm" /></button
      >
    </div>
  </div>
  <LifecycleActions {snapshot} {onrefresh} {compact}>
    {#snippet compactBar(primary)}<PullRequestCompact
        {snapshot}
        title={metadataTitle ?? pr?.title ?? ""}
        {compact}
        {busy}
        {primary}
        oncopy={copy}
        {onrefresh}
        {onunlink}
        {oncontext}
        {onclose}
      />{/snippet}
  </LifecycleActions>
</header>
