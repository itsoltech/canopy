<script lang="ts">
  import { untrack } from "svelte";
  import { paletteInputClass } from "#lib/features/commands/palette-style.ts";
  import PaletteFooter from "#lib/features/commands/PaletteFooter.svelte";
  import { remoteUrl, type SourceKind } from "./add-project-flow.ts";
  import StepHeader from "./StepHeader.svelte";

  /**
   * The remote of a clone: a Git URL or GitHub `owner/repo`. Enter checks the format and continues to the parent
   * directory. The clone uses the worker computer's own Git sign-in (credential helper, SSH keys).
   */
  let {
    source,
    computer,
    initial = "",
    oncontinue,
    onback,
    onclose,
  }: {
    source: SourceKind;
    computer: string;
    initial?: string;
    oncontinue: (remote: string, url: string) => void;
    onback: () => void;
    onclose: () => void;
  } = $props();

  const id = $props.id();
  let input = $state<HTMLInputElement>();

  // Read once: going back to this step mounts it again with the remote typed before.
  let value = $state(untrack(() => initial));
  let error = $state<string>();
  let touched = $state(false);
  const result = $derived(remoteUrl(source, value));

  function submit() {
    if ("error" in result) error = result.error;
    else oncontinue(value.trim(), result.url);
  }

  $effect(() => {
    if (!touched && initial) value = initial;
  });

  $effect(() => input?.focus());

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;

    if (event.key === "Enter") {
      event.preventDefault();
      submit();

      return;
    }

    if (event.key === "Backspace" && value === "") {
      event.preventDefault();
      onback();
    }
  }
</script>

<StepHeader {onback} {onclose} onsubmit={submit} disabledReason={"error" in result ? result.error : undefined}>
  <input
    bind:this={input}
    bind:value
    name="add-project-remote"
    type="text"
    aria-label={source === "github" ? "GitHub repository" : "Git URL"}
    aria-invalid={Boolean(error) || undefined}
    aria-describedby="{id}-hint"
    placeholder={source === "github" ? "owner/repo" : "https://github.com/owner/repo.git"}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    enterkeyhint="next"
    oninput={() => {
      touched = true;
      error = undefined;
    }}
    {onkeydown}
    class={paletteInputClass}
  />
</StepHeader>

<div class="grid gap-1 px-4 py-4 text-base/6 sm:text-sm/6">
  {#if error}
    <p id="{id}-hint" class="text-rose-700 dark:text-rose-400" role="alert">{error}</p>
  {:else}
    <p id="{id}-hint" class="text-zinc-500 dark:text-zinc-400">
      {computer} clones with its own Git sign-in. Private repositories need access there.
    </p>
  {/if}
</div>

<PaletteFooter
  hints={[
    { hotkeys: ["Enter"], label: "Continue" },
    { hotkeys: ["Backspace"], label: "Back" },
    { hotkeys: ["Escape"], label: "Close" },
  ]}
/>
