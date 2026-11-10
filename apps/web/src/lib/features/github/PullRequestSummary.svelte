<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { safeHref } from "@canopy/domain/markdown";
  import { formatTime } from "#lib/shared/format.ts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import PullRequestState from "./PullRequestState.svelte";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  const pr = $derived(snapshot.summary);
  const ref = $derived(pr?.ref);
  let copied = $state(false);
  let error = $state("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(`gh pr checkout ${ref?.number}`);
      copied = true;
    } catch {
      error = "Could not copy the command. Select it and copy it manually.";
    }
  }
</script>

<article class={["grid min-w-0 gap-6 text-base/6 text-zinc-800 sm:text-sm/6 dark:text-zinc-200", className]}>
  <header class="grid min-w-0 gap-3">
    <p class="break-all text-zinc-500 dark:text-zinc-400">
      {ref?.repositoryName} <span class="tabular-nums">#{ref?.number}</span>
    </p>
    <h1 class="text-2xl font-semibold text-balance break-words text-zinc-950 dark:text-white">{pr?.title}</h1>
    <div class="flex flex-wrap items-center gap-3">
      <PullRequestState state={pr?.state ?? ""} />
      <p>{snapshot.author} · Updated {formatTime(pr?.updatedAt)}</p>
    </div>
    <p class="font-mono break-all">{snapshot.baseRef} ← {snapshot.headRef}</p>
    <p class="tabular-nums">
      {snapshot.files} files · <span class="text-emerald-700 dark:text-emerald-300">+{snapshot.additions}</span> /
      <span class="text-red-700 dark:text-red-300">−{snapshot.deletions}</span>
    </p>
    <div class="flex min-w-0 flex-wrap items-center gap-3">
      <code class="break-all select-all">gh pr checkout {ref?.number}</code><Button size="sm" onclick={copy}
        >Copy command</Button
      ><span role="status" class="min-w-12">{copied ? "Copied" : ""}</span>
    </div>
    <p class="text-zinc-500 dark:text-zinc-400">Run in {ref?.repositoryName}.</p>
    {#if snapshot.detail}<Alert
        >{snapshot.detail} {snapshot.stale ? `Last verified ${formatTime(pr?.verifiedAt)}.` : ""}</Alert
      >{/if}
    {#if error}<Alert>{error}</Alert>{/if}
  </header>
  <section aria-labelledby="pr-people" class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-5 dark:border-white/10">
    <h2 id="pr-people" class="font-semibold">Reviewers</h2>
    {#if snapshot.reviewers.length}<ul role="list" class="grid gap-1">
        {#each snapshot.reviewers as reviewer, i (`${reviewer.login}:${i}`)}<li class="break-words">
            {reviewer.login} · {reviewer.state.replaceAll("_", " ")}
          </li>{/each}
      </ul>{:else}<p class="text-zinc-500 dark:text-zinc-400">No reviewers requested</p>{/if}
    {#if snapshot.assignees.length}<p class="break-words">Assigned to {snapshot.assignees.join(", ")}</p>{/if}
    {#if snapshot.labels.length}<div aria-label="Labels" class="flex min-w-0 flex-wrap gap-2">
        {#each snapshot.labels as label, i (`${label}:${i}`)}<span
            class="max-w-full rounded-md bg-zinc-500/10 px-2 py-0.5 break-words">{label}</span
          >{/each}
      </div>{/if}
  </section>
  <section
    aria-labelledby="pr-description"
    class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-5 dark:border-white/10"
  >
    <h2 id="pr-description" class="font-semibold">Description</h2>
    {#if snapshot.body}<Markdown text={snapshot.body} />{:else}<p class="text-zinc-500 dark:text-zinc-400">
        No description provided
      </p>{/if}
  </section>
  <section aria-labelledby="pr-checks" class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-5 dark:border-white/10">
    <h2 id="pr-checks" class="font-semibold">Checks · {pr?.checksState || "unavailable"}</h2>
    <p class="font-mono break-all text-zinc-500 dark:text-zinc-400">{pr?.headSha}</p>
    {#if snapshot.checks.length}<ul role="list" class="grid min-w-0 divide-y divide-zinc-950/5 dark:divide-white/10">
        {#each snapshot.checks as check, i (`${check.name}:${i}`)}<li class="grid min-w-0 gap-1 py-3">
            <div class="flex flex-wrap justify-between gap-2">
              <p class="min-w-0 font-medium break-words">{check.name}</p>
              <p>{check.state.replaceAll("_", " ")}</p>
            </div>
            <p class="break-words text-zinc-500 dark:text-zinc-400">{check.provider}</p>
            {#if safeHref(check.url)}<a
                class="w-fit rounded-md underline focus-ring"
                href={safeHref(check.url)}
                target="_blank"
                rel="noreferrer">Open check</a
              >{/if}
          </li>{/each}
      </ul>{:else}<p class="text-zinc-500 dark:text-zinc-400">No checks available</p>{/if}
  </section>
</article>
