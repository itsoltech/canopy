<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { safeHref } from "@canopy/domain/markdown";
  import Diff from "#lib/features/threads/components/Diff.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";
  import { PullRequestPages } from "./pages.svelte.ts";
  import PageControls from "./PageControls.svelte";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  let commit = $state("");
  let selected = $state<github.PullRequestFile>();
  let patch = $state<github.PullRequestDiff>();
  let busy = $state(false);
  let error = $state("");
  let version = 0;
  const id = $derived(snapshot.summary?.ref?.id ?? "");
  const headSha = $derived(snapshot.summary?.headSha ?? "");
  const baseSha = $derived(snapshot.baseSha);

  const base = $derived(
    create(github.PullRequestPageRequestSchema, {
      pullRequestId: id,
      headSha,
      baseSha,
      commitSha: commit,
    }),
  );

  const pages = $derived.by(() => {
    const request = base;

    return new PullRequestPages((cursor, refresh) =>
      api.page(
        "files",
        github.PullRequestFilesPageSchema,
        create(github.PullRequestPageRequestSchema, { ...request, cursor, refresh }),
      ),
    );
  });

  const commits = $derived(
    new PullRequestPages((cursor, refresh) =>
      api.page(
        "commits",
        github.PullRequestCommitsPageSchema,
        create(github.PullRequestPageRequestSchema, { pullRequestId: id, cursor, refresh }),
      ),
    ),
  );

  const options = $derived([
    { value: "", label: "All commits" },
    ...commits.pages.flatMap((p) =>
      p.commits.map((c) => ({ value: c.sha, label: `${c.sha.slice(0, 7)} ${c.subject}` })),
    ),
  ]);

  $effect(() => {
    const target = pages;
    untrack(() => {
      selected = undefined;
      patch = undefined;
      version++;
      void target.read();
    });

    return invalidations.subscribe(id, () => void target.invalidate());
  });

  $effect(() => {
    const target = commits;
    untrack(() => void target.read());

    return invalidations.subscribe(id, () => void target.invalidate());
  });

  async function open(file: github.PullRequestFile) {
    selected = file;
    patch = undefined;
    error = "";
    busy = true;
    const generation = ++version;

    try {
      const value = await api.page(
        "diff",
        github.PullRequestDiffSchema,
        create(github.PullRequestPageRequestSchema, { ...base, path: file.path, resourceId: String(file.sourcePage) }),
      );

      if (generation === version) patch = value;
    } catch {
      if (generation === version) error = "Changes updated or unavailable. Refresh the files, then retry.";
    } finally {
      if (generation === version) busy = false;
    }
  }
</script>

<section aria-label="Code" class={["grid min-w-0 gap-3", className]}>
  <Select aria-label="Commit filter" bind:value={commit} {options} />
  {#if commits.current?.page?.nextCursor}<Button
      variant="ghost"
      disabled={commits.busy}
      onclick={() => void commits.read(true)}>Load more commits</Button
    >{/if}
  {#if commit}<p class="text-sm/5 text-zinc-500 sm:text-xs/5">Changes against this commit’s first parent</p>{/if}
  <ul role="list" class="grid min-w-0 divide-y divide-zinc-950/5 dark:divide-white/10">
    {#each pages.current?.files ?? [] as file (file.path)}<li class="min-w-0">
        <button
          type="button"
          aria-expanded={selected?.path === file.path}
          onclick={() => void open(file)}
          class="flex min-h-11 w-full min-w-0 items-center gap-2 py-2 text-left text-sm/5 focus-ring sm:min-h-9 sm:text-xs/5"
        >
          <p
            class="min-w-0 flex-1 truncate font-mono"
            title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
          >
            {file.previousPath ? `${file.previousPath} → ` : ""}{file.path}
          </p>
          <p class="shrink-0 tabular-nums">
            <span class="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>
            <span class="text-rose-700 dark:text-rose-400">−{file.deletions}</span>
          </p>
        </button>
        {#if selected?.path === file.path}<div class="grid min-w-0 gap-2 pb-3">
            <div class="flex flex-wrap gap-3 text-sm sm:text-xs">
              <Checkbox
                name="wrap"
                label="Wrap"
                bind:checked={
                  () => device.values.wrapDiffs === "on", (checked) => device.set("wrapDiffs", checked ? "on" : "off")
                }
              />
              <Checkbox
                name="whitespace"
                label="Hide whitespace"
                bind:checked={
                  () => device.values.hideWhitespace === "on",
                  (checked) => device.set("hideWhitespace", checked ? "on" : "off")
                }
              />
            </div>
            {#if busy}<p role="status">Loading patch…</p>{/if}
            {#if error}<p role="alert">{error}</p>
              <Button variant="ghost" onclick={() => void open(file)}>Retry</Button>{/if}
            {#if patch?.patch}<Diff diff={patch.patch} label={file.path} />{:else if patch}<p
                class="text-sm/5 text-zinc-500"
              >
                {patch.page?.detail || "Binary file or patch unavailable. Open on GitHub to read this file."}
              </p>{/if}
            {#if safeHref(file.url)}<a
                href={safeHref(file.url)}
                target="_blank"
                rel="noreferrer"
                class="text-sm text-zinc-500 hover:underline">Open on GitHub</a
              >{/if}
          </div>{/if}
      </li>{/each}
  </ul>
  <PageControls
    page={pages.current?.page}
    busy={pages.busy}
    error={pages.error}
    previous={pages.index ? () => pages.index-- : undefined}
    next={() => void pages.read(true)}
    retry={() => void pages.read(false, true)}
  />
</section>
