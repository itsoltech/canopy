<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import type { KeyAction } from "./profiles.ts";

  /**
   * A secret the gateway stores and never sends back: while one is set it reads "Set" with Replace (and Clear when
   * allowed); replacing shows a password field and a way back to the stored value. Without a stored value it is a
   * plain password field. Inside a `Field`, the input takes the field's label.
   */
  let {
    set,
    action = $bindable(),
    value = $bindable(""),
    name,
    label,
    allowClear = false,
    placeholder,
    class: className,
  }: {
    set: boolean;
    action: KeyAction;
    value?: string;
    name: string;
    /** Accessible name of the input when it is not inside a `Field`. */
    label?: string;
    allowClear?: boolean;
    placeholder?: string;
    class?: ClassValue;
  } = $props();
</script>

{#if set && action !== "replace"}
  <div class={["flex min-h-9 flex-wrap items-center gap-2", className]}>
    {#if action === "clear"}
      <Badge tone="amber">Will be removed</Badge>
      <Button size="sm" variant="ghost" onclick={() => (action = "keep")}>Undo</Button>
    {:else}
      <Badge tone="emerald" icon="lock-closed">Set</Badge>
      <Button size="sm" onclick={() => ((action = "replace"), (value = ""))}>Replace</Button>
      {#if allowClear}<Button size="sm" variant="ghost" onclick={() => (action = "clear")}>Clear</Button>{/if}
    {/if}
  </div>
{:else}
  <div class={["flex items-center gap-2", className]}>
    <Input type="password" {name} bind:value autocomplete="off" spellcheck="false" aria-label={label} {placeholder} class="min-w-0 flex-1 font-mono" />
    {#if set}<Button size="sm" variant="ghost" onclick={() => ((action = "keep"), (value = ""))}>Keep current</Button>{/if}
  </div>
{/if}
