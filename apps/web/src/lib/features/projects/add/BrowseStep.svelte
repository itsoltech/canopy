<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import { moveActive, movementOf } from "#lib/features/commands/palette.ts";
  import {
    paletteEmptyClass,
    paletteGroupLabelClass,
    paletteInputClass,
    paletteListClass,
  } from "#lib/features/commands/palette-style.ts";
  import PaletteFooter from "#lib/features/commands/PaletteFooter.svelte";
  import PaletteOption from "#lib/features/commands/PaletteOption.svelte";
  import { pathSeparator } from "#lib/features/overview/workers.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { ACTION_LABELS, BUSY_LABELS, browseTarget, type BrowseMode } from "./add-project-flow.ts";
  import { directoryText, matching, parsePath, tidyText, upText, type PathStyle } from "./browse-path.ts";
  import { DirectoryListing } from "./directory-listing.svelte.ts";
  import StepHeader from "./StepHeader.svelte";

  /**
   * Browses a worker's directories from a typed path (`~/GIT/pin`): the part up to the last separator is the
   * listed directory, the rest filters it. `/` descends, `..` goes up, ↑↓ pick an entry and Enter opens it. With
   * no entry picked, Enter runs the action for the typed path (Mod+Enter always does): add it, or create or clone
   * a new directory named by the filter.
   */
  let {
    worker,
    mode,
    name = "",
    parent = "",
    actionLabel,
    busy = false,
    error,
    onsubmit,
    onback,
    onclose,
  }: {
    worker: ui.Worker;
    mode: BrowseMode;
    /** Starting name of the new directory (a clone's repository name). */
    name?: string;
    parent?: string;
    actionLabel?: string;
    busy?: boolean;
    error?: string | undefined;
    onsubmit: (target: { dir: string; name: string }) => void;
    onback: () => void;
    onclose: () => void;
  } = $props();

  const id = $props.id();
  const label = $derived(actionLabel ?? ACTION_LABELS[mode]);
  const listing = untrack(() => new DirectoryListing(worker.id));
  let input = $state<HTMLInputElement>();
  let text = $state("");
  let realHome = $state("");

  /** -1: no entry picked, Enter runs the action. */
  let active = $state(-1);

  const style: PathStyle = $derived({ sep: pathSeparator(worker.os), homes: [worker.homeDirectory, realHome] });
  const typed = $derived(parsePath(text, style));
  const loaded = $derived(!listing.loading && listing.requestedPath === typed.dir ? listing.current : undefined);
  const listingError = $derived(listing.requestedPath === typed.dir ? listing.error : undefined);
  const names = $derived(loaded ? matching(loaded.names, typed.filter) : []);

  const showUp = $derived(
    Boolean(loaded) && upText(typed.dir, style) !== directoryText(typed.dir, style) && /^\.{0,2}$/.test(typed.filter),
  );

  const rows = $derived([...(showUp ? [".."] : []), ...names]);
  const target = $derived(browseTarget(mode, { ...typed, dir: loaded?.path ?? typed.dir }, loaded?.names, style.sep));
  const ready = $derived(target && "dir" in target ? target : undefined);
  const notice = $derived(error ?? (target && "reason" in target ? target.reason : ""));

  // The home directory first: its real path collapses to `~` as well.
  $effect(() => {
    void listing.home().then(
      (home) => {
        realHome = home.path;

        if (!text) text = `${directoryText(untrack(() => parent) || home.path, style)}${untrack(() => name)}`;
      },
      () => (text ||= `~${style.sep}`),
    );
  });

  $effect(() => {
    if (typed.dir) void listing.open(typed.dir);
  });

  $effect(() => {
    if (loaded && loaded.path !== typed.dir) setText(`${directoryText(loaded.path, style)}${typed.filter}`);
  });

  $effect(() => input?.focus());

  function setText(next: string) {
    text = next;
    active = -1;
    input?.focus();
  }

  /** Opens an entry, or goes up for `..`. */
  function enter(row: string) {
    setText(row === ".." ? upText(typed.dir, style) : `${directoryText(typed.dir, style)}${row}${style.sep}`);
  }

  function submit() {
    if (ready && !busy) onsubmit({ dir: ready.dir, name: ready.name });
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const movement = movementOf(event);

    if (movement) {
      event.preventDefault();
      active = moveActive(active, movement, rows.length);
      document.getElementById(`${id}-row-${active}`)?.scrollIntoView({ block: "nearest" });

      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];

      if (row !== undefined && !(event.metaKey || event.ctrlKey)) enter(row);
      else submit();

      return;
    }

    if (event.key === "Tab" && !event.shiftKey && (rows[active] ?? (names.length === 1 ? names[0] : undefined))) {
      event.preventDefault();
      enter(rows[active] ?? names[0]!);

      return;
    }

    if (event.key !== "Backspace" || input?.selectionStart !== input?.selectionEnd) return;

    // Back to the previous step from the start; one directory up from a path that ends with the separator.
    if (text === "" || text === `~${style.sep}` || text === style.sep) {
      event.preventDefault();
      onback();
    } else if (text.endsWith(style.sep) && typed.dir) {
      event.preventDefault();
      setText(upText(typed.dir, style));
    }
  }
</script>

<StepHeader {onback} {onclose}>
  <input
    bind:this={input}
    value={text}
    name="add-project-path"
    type="text"
    role="combobox"
    aria-expanded="true"
    aria-controls="{id}-list"
    aria-autocomplete="list"
    aria-activedescendant={active >= 0 ? `${id}-row-${active}` : undefined}
    aria-label="Path on {worker.name}"
    aria-describedby="{id}-status"
    placeholder="~{style.sep}"
    readonly={busy}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    enterkeyhint="go"
    oninput={(event) => setText(tidyText(event.currentTarget.value, style))}
    {onkeydown}
    class={[paletteInputClass, "font-mono text-sm/6 sm:text-[0.8125rem]/6"]}
  />
  {#snippet action()}
    <Button size="sm" variant={ready ? "primary" : "secondary"} disabled={!ready} loading={busy} onclick={submit}>
      {busy ? BUSY_LABELS[mode] : label}
      {#if !busy}<Kbd hotkey={active >= 0 ? "Mod+Enter" : "Enter"} class={ready ? "text-white/75!" : undefined} />{/if}
    </Button>
  {/snippet}
</StepHeader>

{#if busy && mode === "clone"}
  <p role="status" class="px-4 py-2 text-sm/5 text-zinc-500 dark:text-zinc-400">
    Cloning on {worker.name}… This stops after 5 minutes.
  </p>
{/if}

<p id="{id}-status" class="sr-only" role="status">{listingError ?? notice}</p>
{#if notice}
  <p
    aria-hidden="true"
    class={[
      "border-b border-zinc-950/5 px-4 py-2 text-sm/5 sm:text-xs/4 dark:border-white/8",
      error ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400",
    ]}
  >
    {notice}
  </p>
{/if}

<div id="{id}-list" role="listbox" aria-label="Directories" class={paletteListClass}>
  <div role="presentation" class={paletteGroupLabelClass}>Directories</div>
  {#if listingError && !loaded}
    <p class={[paletteEmptyClass, "wrap-anywhere"]}>{listingError}</p>
  {:else if typed.dir && listing.loading}
    <div class="grid gap-1 px-3 py-2" aria-hidden="true">
      {#each [0, 1, 2, 3] as row (row)}<Skeleton class="h-6 w-full max-w-64" />{/each}
    </div>
  {:else if loaded}
    {#each rows as row, index (row)}
      <PaletteOption
        id="{id}-row-{index}"
        title={row}
        icon={row === ".." ? "arrow-uturn-left" : "folder"}
        status={loaded.git.has(row) ? "Git" : undefined}
        active={index === active}
        onchoose={() => enter(row)}
        onpoint={() => (active = index)}
      />
    {/each}
    {#if names.length === 0}
      <p class={[paletteEmptyClass, "truncate"]}>
        {#if ready && mode !== "add"}New directory: <span class="font-mono"
            >{directoryText(ready.dir, style)}{ready.name}</span
          >{:else if typed.filter}No directories match “{typed.filter}”{:else}No directories here{/if}
      </p>
    {/if}
  {:else}
    <p class={paletteEmptyClass}>Enter a directory path</p>
  {/if}
</div>

<PaletteFooter
  hints={[
    { hotkeys: ["ArrowUp", "ArrowDown"], label: "Navigate" },
    { hotkeys: ["Enter"], label: active >= 0 ? "Open" : label },
    { hotkeys: ["Backspace"], label: "Back" },
    { hotkeys: ["Escape"], label: "Close" },
  ]}
/>
