<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { fileRows } from "@canopy/domain/github-read";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import CodeToolbar from "./CodeToolbar.svelte";
  import CodeFile from "./CodeFile.svelte";
  import { PullRequestPages } from "./pages.svelte.ts";
  import PageControls from "./PageControls.svelte";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  let commit = $state("");
  let tree = $state(false);
  let collapsed = $state(new Set<string>());
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

  const files = $derived(pages.current?.files ?? []);
  const rows = $derived(fileRows(files, tree, collapsed));

  const options = $derived([
    { value: "", label: "All commits" },
    ...commits.pages.flatMap((p) =>
      p.commits.map((c) => ({ value: c.sha, label: `${c.sha.slice(0, 7)} ${c.subject}` })),
    ),
  ]);

  $effect(() => {
    void pages.current;
    untrack(close);
  });

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

  async function open(file: github.PullRequestFile, force = false) {
    selected = file;
    patch = undefined;
    error = "";
    busy = force || file.patchState === "available";
    const generation = ++version;

    if (!busy) return;

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

  function close() {
    selected = undefined;
    patch = undefined;
    busy = false;
    version++;
  }
</script>

<section aria-label="Code" class={["min-w-0", className]}>
  <CodeToolbar
    bind:commit
    bind:tree
    {options}
    count={commit ? `${files.length}${pages.current?.page?.nextCursor ? "+" : ""}` : String(snapshot.files)}
    more={commits.current?.page?.nextCursor ? () => void commits.read(true) : undefined}
    busy={commits.busy}
  />
  {#if commit}<p class="py-2 text-sm/5 text-zinc-500 sm:text-xs/5">Changes against this commit’s first parent</p>{/if}
  <ul role="list" class="min-w-0">
    {#each rows as row (row.key)}
      {#if row.kind === "folder"}<li>
          <button
            type="button"
            class="flex min-h-10 w-full items-center gap-2 text-left text-sm focus-ring sm:text-xs"
            style:padding-left={`${Math.min(row.depth, 6) * 12}px`}
            aria-expanded={!collapsed.has(row.key)}
            onclick={() => {
              const next = new Set(collapsed);
              if (!next.delete(row.key)) next.add(row.key);
              collapsed = next;
            }}
            ><Icon name={collapsed.has(row.key) ? "chevron-right" : "chevron-down"} size="sm" /><Icon
              name={collapsed.has(row.key) ? "folder" : "folder-open"}
            /><span class="truncate">{row.name}</span></button
          >
        </li>
      {:else}<CodeFile
          file={row.file}
          active={selected?.path === row.file.path}
          {patch}
          {busy}
          {error}
          depth={row.depth}
          onexpand={() => void open(row.file)}
          onopen={() => void open(row.file, true)}
          onclose={close}
        />{/if}
    {/each}
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
