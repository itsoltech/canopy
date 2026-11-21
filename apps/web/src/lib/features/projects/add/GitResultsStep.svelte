<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { paletteEmptyClass, paletteListClass, paletteRowClass } from "#lib/features/commands/palette-style.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { pathSeparator } from "#lib/features/overview/workers.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import type { DirectoryListing } from "./directory-listing.svelte.ts";
  import StepHeader from "./StepHeader.svelte";

  let {
    worker,
    listing,
    parent,
    busy,
    error,
    onsubmit,
    onback,
    onclose,
  }: {
    worker: ui.Worker;
    listing: DirectoryListing;
    parent: string;
    busy: boolean;
    error: string | undefined;
    onsubmit: (directory: string) => void;
    onback: () => void;
    onclose: () => void;
  } = $props();

  const id = $props.id();
  const overview = useOverview();
  let heading = $state<HTMLHeadingElement>();
  let selected = $state<string>();

  const loaded = $derived(!listing.loading && listing.requestedPath === parent ? listing.current : undefined);
  const readError = $derived(listing.requestedPath === parent ? listing.error : undefined);

  const addedPaths = $derived(
    new Set(
      overview.projects.flatMap((project) =>
        project.kind === "scratch"
          ? []
          : project.workspaces.flatMap((workspace) => (workspace.workerId === worker.id ? [workspace.rootPath] : [])),
      ),
    ),
  );

  const repositories = $derived.by(() => {
    if (!loaded) return [];
    const sep = pathSeparator(worker.os);
    const prefix = loaded.path.endsWith(sep) ? loaded.path : loaded.path + sep;

    return loaded.names.flatMap((name) => (loaded.git.has(name) ? [{ name, path: prefix + name }] : []));
  });

  const target = $derived(loaded?.git.size === 0 ? loaded.path : selected);

  const disabledReason = $derived.by(() => {
    if (readError) return "Choose another directory.";

    if (!loaded) return "Reading directories…";

    if (!target) return "Choose a repository.";

    if (addedPaths.has(target)) return "Already added";

    return undefined;
  });

  $effect(() => {
    void listing.open(parent);
  });

  $effect(() => heading?.focus());

  function submit() {
    if (target && !disabledReason && !busy) onsubmit(target);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing || event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    submit();
  }
</script>

<div role="presentation" class="contents" {onkeydown}>
  <StepHeader {onback} {onclose} onsubmit={submit} actionLabel="Add directory" {disabledReason} {busy} modifiedEnter>
    <h2
      bind:this={heading}
      tabindex="-1"
      aria-describedby="{id}-location"
      class="min-w-0 flex-1 text-base font-medium focus:outline-none sm:text-sm"
    >
      <TruncatedText text="Git repositories" />
    </h2>
  </StepHeader>

  <div id="{id}-location" class="shrink-0 border-b border-divider px-4 py-2 text-sm/5 sm:text-xs/4">
    <TruncatedText text={worker.name} class="font-medium" />
    <TruncatedText text={loaded?.path ?? parent} class="font-mono text-muted" />
  </div>
  {#if error}<p
      role="alert"
      class="shrink-0 border-b border-divider px-4 py-2 text-sm wrap-anywhere text-rose-700 dark:text-rose-400"
    >
      {error}
    </p>{/if}

  <div class={paletteListClass}>
    {#if readError || loaded?.git.size === 0}
      <div class={[paletteEmptyClass, "flex flex-col items-center gap-3"]}>
        <p role="status" class="wrap-anywhere">{readError ?? "No Git repositories in this directory."}</p>
        {#if target && addedPaths.has(target)}<p class="text-sm">Already added</p>{/if}
        <Button size="sm" onclick={onback} disabled={busy}>Choose directory</Button>
      </div>
    {:else if !loaded}
      <p role="status" class={paletteEmptyClass}>Reading directories…</p>
    {:else}
      <ul aria-label="Git repositories">
        {#each repositories as repository (repository.path)}
          {@const added = addedPaths.has(repository.path)}
          {@const chosen = selected === repository.path}
          <li>
            <button
              type="button"
              aria-pressed={chosen}
              data-active={chosen || undefined}
              disabled={added || busy}
              class={[paletteRowClass, "w-full text-left focus-ring enabled:hover:bg-hover disabled:opacity-70"]}
              onclick={() => (selected = repository.path)}
            >
              <Icon name="folder" tone="muted" />
              <span class="grid min-w-0 flex-1 gap-0.5">
                <TruncatedText text={repository.name} />
                <TruncatedText text={repository.path} class="font-mono text-sm/5 text-muted sm:text-xs/4" />
              </span>
              {#if added}<span class="shrink-0 text-sm/5 text-muted sm:text-xs/4">Already added</span>
              {:else}<span class="grid size-4 shrink-0 place-items-center" aria-hidden="true">
                  {#if chosen}<Icon name="check" tone="muted" />{/if}
                </span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
