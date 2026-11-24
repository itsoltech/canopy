<script lang="ts">
  import { tick } from "svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  /**
   * A masked, write-only value field inside a `Field` (which supplies its id and label). It is a text input with
   * masking rather than a password field, so password managers do not offer to save it. Reveal checks a typo.
   *
   * A one-line input drops line breaks from pasted text, which would corrupt a key file. A paste or drop that
   * contains a line break is therefore taken over whole and kept exactly, outside the input: the field then
   * reads "Multiline value pasted" and offers Clear, never showing the value.
   */
  let {
    value = $bindable(""),
    disabled = false,
    autofocus = false,
    oninput,
  }: { value?: string; disabled?: boolean; autofocus?: boolean; oninput?: () => void } = $props();

  let revealed = $state(false);
  let box = $state<HTMLDivElement>();
  let failure = $state("");
  const multiline = $derived(/[\r\n]/.test(value));

  $effect(() => {
    if (!value.length) revealed = false;
  });

  /** Switching between the input and its stand-in replaces the focused element; keep focus in the field. */
  async function refocus() {
    await tick();
    box?.querySelector("input")?.focus();
  }

  function take(text: string | undefined, event: Event) {
    if (text === undefined || !/[\r\n]/.test(text)) return;
    event.preventDefault();
    value = text;
    failure = "";
    oninput?.();
    void refocus();
  }

  async function paste() {
    try {
      value = await navigator.clipboard.readText();
      failure = "";
      oninput?.();
      void refocus();
    } catch {
      failure = "Use your browser’s Paste command in the field.";
    }
  }

  function clear() {
    value = "";
    oninput?.();
    void refocus();
  }
</script>

<div class="grid gap-1">
  <div class="flex min-w-0 items-center gap-2">
    <div class="min-w-0 flex-1" bind:this={box}>
      {#if multiline}
        <!-- Stands in for the value: the input cannot hold line breaks, and the value is never shown. -->
        <Input
          name="project-secret-value"
          type="text"
          value="Multiline value pasted"
          readonly
          class="text-zinc-500 dark:text-zinc-400"
          data-autofocus={autofocus ? "" : undefined}
          {disabled}
        />
      {:else}
        <Input
          name="project-secret-value"
          type="text"
          bind:value
          {oninput}
          onpaste={(event) => take(event.clipboardData?.getData("text/plain"), event)}
          ondrop={(event) => take(event.dataTransfer?.getData("text/plain"), event)}
          class={["font-mono", !revealed && "[-webkit-text-security:disc]"]}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-autofocus={autofocus ? "" : undefined}
          {disabled}
        />
      {/if}
    </div>
    {#if multiline}
      <IconButton icon="x-mark" label="Clear value" {disabled} onclick={clear} />
    {:else}
      <IconButton
        icon={revealed ? "eye-slash" : "eye"}
        label={revealed ? "Hide value" : "Show value"}
        aria-pressed={revealed}
        {disabled}
        onclick={() => (revealed = !revealed)}
      />
      <IconButton icon="clipboard-document" label="Paste value" {disabled} onclick={() => void paste()} />
    {/if}
  </div>
  {#if failure}<p role="alert" class="text-sm/5 text-rose-600 dark:text-rose-400">{failure}</p>{/if}
</div>
