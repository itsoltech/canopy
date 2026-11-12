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
  import { ReviewDraft } from "./review-draft.svelte.ts";
  import ReviewBar from "./ReviewBar.svelte";
  import ReadSkeleton from "./ReadSkeleton.svelte";
  import { queries } from "#lib/shared/queries.svelte.ts";

  interface CodeView {
    commit: string;
    tree: boolean;
    collapsed: Set<string>;
    selected?: github.PullRequestFile;
    patch?: github.PullRequestDiff;
  }

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();

  const saved = untrack(
    () =>
      queries.snapshot<CodeView>(
        `CodeView:${snapshot.accountId}:${snapshot.accessRevision}:${snapshot.summary?.ref?.id}`,
      ).data,
  );

  let commit = $state(saved?.commit ?? "");
  let tree = $state(saved?.tree ?? false);
  let collapsed = $state(saved?.collapsed ?? new Set<string>());
  let selected = $state<github.PullRequestFile | undefined>(saved?.selected);
  let patch = $state<github.PullRequestDiff | undefined>(saved?.patch);
  let busy = $state(false);
  let error = $state("");
  let version = 0;
  let viewedChanges = $state(new Map<string, string>());
  const id = $derived(snapshot.summary?.ref?.id ?? "");
  const headSha = $derived(snapshot.summary?.headSha ?? "");
  const baseSha = $derived(snapshot.baseSha);
  const cacheScope = $derived(`${snapshot.accountId}:${snapshot.accessRevision}:${id}:${headSha}:${baseSha}`);
  const draft = $derived(new ReviewDraft(id, headSha, `ReviewDraft:${cacheScope}`));
  let comparison = untrack(() => `${cacheScope}:${commit}`);

  $effect(() => {
    const next = `${cacheScope}:${commit}`;
    untrack(() => {
      if (comparison === next) return;
      comparison = next;
      close();
    });
  });

  $effect(() =>
    queries.set(`CodeView:${snapshot.accountId}:${snapshot.accessRevision}:${id}`, {
      commit,
      tree,
      collapsed,
      selected,
      patch,
    }),
  );

  $effect(() => {
    const target = draft;
    untrack(() => void target.read(false, false));
    const unsubscribe = invalidations.subscribe(`${id}:reviews`, () => void target.read(false, false));
    const manual = invalidations.subscribe(id, () => void target.read());

    return () => {
      unsubscribe();
      manual();
      target.close();
    };
  });

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

    return new PullRequestPages(
      (cursor, refresh) =>
        api.page(
          "files",
          github.PullRequestFilesPageSchema,
          create(github.PullRequestPageRequestSchema, { ...request, cursor, refresh }),
        ),
      `files:${cacheScope}:${commit}`,
    );
  });

  const commits = $derived(
    new PullRequestPages(
      (cursor, refresh) =>
        api.page(
          "commits",
          github.PullRequestCommitsPageSchema,
          create(github.PullRequestPageRequestSchema, { pullRequestId: id, cursor, refresh }),
        ),
      `commits:${cacheScope}`,
    ),
  );

  const files = $derived(pages.current?.files ?? []);
  const rows = $derived(fileRows(files, tree, collapsed));

  const viewedCount = $derived(
    (pages.current?.viewedCount ?? 0) +
      files.reduce(
        (n, f) =>
          n +
          (viewedChanges.has(f.path)
            ? Number(viewedChanges.get(f.path) === "VIEWED") - Number(f.viewerViewedState === "VIEWED")
            : 0),
        0,
      ),
  );

  const options = $derived([
    { value: "", label: "All commits" },
    ...commits.pages.flatMap((p) =>
      p.commits.map((c) => ({ value: c.sha, label: `${c.sha.slice(0, 7)} ${c.subject}` })),
    ),
  ]);

  $effect(() => {
    const current = pages.current;
    viewedChanges = new Map();
    untrack(() => {
      const file = current?.files.find((f) => f.path === selected?.path);

      if (!file || (patch && patch.page?.headSha !== current?.page?.headSha)) close();
      else selected = file;
    });
  });

  $effect(() => {
    const target = pages;
    untrack(() => {
      version++;
      void target.read();
    });

    const all = invalidations.subscribe(id, () => void target.invalidate(true));
    const resource = invalidations.subscribe(`${id}:files`, () => void target.invalidate(true, false));

    return () => {
      all();
      resource();
    };
  });

  $effect(() => {
    const target = commits;
    untrack(() => void target.read());

    const all = invalidations.subscribe(id, () => void target.invalidate());
    const resource = invalidations.subscribe(`${id}:commits`, () => void target.invalidate(false, false));

    return () => {
      all();
      resource();
    };
  });

  $effect(() => {
    const target = pages;
    const review = draft;

    const refresh = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void target.read(false, true);
        void review.read(false, false);
      }
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);

    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  });

  async function open(file: github.PullRequestFile, force = false) {
    if (selected?.path !== file.path) patch = undefined;
    selected = file;
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
  <ReviewBar {snapshot} {draft} />
  <CodeToolbar
    bind:commit
    bind:tree
    {options}
    count={commit ? `${files.length}${pages.current?.page?.nextCursor ? "+" : ""}` : String(snapshot.files)}
    more={commits.current?.page?.nextCursor ? () => void commits.read(true) : undefined}
    busy={commits.busy}
    error={commits.error}
    retry={() => void commits.read(false, true)}
    viewed={pages.current?.viewedComplete ? `${viewedCount}/${pages.current.viewedTotal}` : "…"}
  />
  {#if commit}<p class="py-2 text-sm/5 text-zinc-500 sm:text-xs/5">Changes against this commit’s first parent</p>{/if}
  {#if !pages.current && !pages.error}<ReadSkeleton />{/if}
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
          {snapshot}
          {draft}
          historical={!!commit}
          stale={!!pages.current?.page?.stale}
          onstate={(path, state) => (viewedChanges = new Map(viewedChanges).set(path, state))}
          onsettled={() => pages.read(false, true)}
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
