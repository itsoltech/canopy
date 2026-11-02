<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import type { ApprovalView } from "../model.ts";
  import ChatCard from "./ChatCard.svelte";

  /**
   * A bot asks before it acts. The card shows what it wants to do and the details as labelled fields; the
   * longest one (the text it would send) is the preview. Approve runs it; Discard declines; Edit lets you
   * rewrite the preview in place and send your version back (nothing runs, the bot proposes it again).
   * "Needs approval ⌄" chooses when this bot asks at all (`policy`), when the caller can save it.
   * Without `onanswer` (a watched chat, or answered) the card is read-only.
   */
  export type ApprovalAnswer = { approve: true } | { approve: false; edited?: string | undefined };
  export type ApprovalPolicy = "safe" | "always";

  let {
    approval,
    answering,
    onanswer,
    policy,
    onpolicy,
    class: className,
  }: {
    approval: ApprovalView;
    /** The answer being sent. */
    answering?: "approve" | "discard" | "edit" | undefined;
    onanswer?: ((answer: ApprovalAnswer) => void) | undefined;
    policy?: ApprovalPolicy | undefined;
    onpolicy?: ((policy: ApprovalPolicy) => void) | undefined;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  const preview = $derived(approval.fields.reduce<(typeof approval.fields)[number] | undefined>((best, f) => (f.value.length > (best?.value.length ?? 39) ? f : best), undefined));
  const details = $derived(approval.fields.filter((f) => f !== preview));
  const open = $derived(approval.status === "pending" && !answering && Boolean(onanswer));
  let editing = $state(false);
  let draft = $state("");
  const outcome: Record<Exclude<ApprovalView["status"], "pending">, string> = { approved: "Approved", discarded: "Discarded", edited: "Sent back with your edits" };

  function edit() {
    draft = preview?.value ?? approval.fields.map((f) => (f.label ? `${f.label}: ${f.value}` : f.value)).join("\n");
    editing = true;
  }
</script>

<ChatCard labelledby="{id}-title" class={className}>
  <header class="flex items-center justify-between gap-3 px-4 pt-3">
    {#if onpolicy && policy}
      <DropdownMenu label="When this bot asks">
        {#snippet trigger(props)}
          <button type="button" {...props} class="relative -ml-1.5 flex items-center gap-1 rounded-md py-0.5 pr-1 pl-1.5 text-sm/5 font-medium text-amber-700 hover:bg-amber-500/10 focus-ring sm:text-xs/5 dark:text-amber-400">
            Needs approval<Icon name="chevron-down" class="size-3.5 fill-current" />
          </button>
        {/snippet}
        <MenuCheckItem checked={policy === "safe"} description="Reversible platform actions run directly; destructive actions and connected service writes ask first." onselect={() => onpolicy("safe")}>Ask before changes</MenuCheckItem>
        <MenuCheckItem checked={policy === "always"} description="Changes and connected service actions ask first. Platform reads run directly." onselect={() => onpolicy("always")}>Ask before every action</MenuCheckItem>
      </DropdownMenu>
    {:else}
      <p class="text-sm/5 font-medium text-amber-700 sm:text-xs/5 dark:text-amber-400">Needs approval</p>
    {/if}
  </header>
  {#if approval.routineTitle}<p class="px-4 pt-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">From routine ‹{approval.routineTitle}›</p>{/if}
  <h3 id="{id}-title" class="px-4 pt-1 text-base/6 font-medium text-pretty text-zinc-950 sm:text-sm/6 dark:text-white">{approval.action}</h3>

  {#if details.length > 0}
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-4 pt-2 text-base/6 sm:text-sm/6">
      {#each details as field, index (index)}
        <dt class="text-zinc-500 dark:text-zinc-400">{field.label || "Detail"}</dt>
        <dd class="min-w-0 wrap-anywhere text-zinc-800 dark:text-zinc-200">{field.value}</dd>
      {/each}
    </dl>
  {/if}

  {#if editing && open}
    <form class="grid gap-2 px-4 pt-3" onsubmit={(event) => { event.preventDefault(); if (draft.trim()) onanswer?.({ approve: false, edited: draft.trim() }); }}>
      <label for="{id}-edit" class="sr-only">Your version</label>
      <!-- svelte-ignore a11y_autofocus -->
      <Textarea id="{id}-edit" name="edited" bind:value={draft} rows={4} autofocus maxlength={32000} />
      <div class="flex justify-end gap-2 pb-3">
        <Button size="sm" variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
        <Button size="sm" type="submit" variant="primary" disabled={!draft.trim()}>Send edits</Button>
      </div>
    </form>
  {:else}
    {#if preview}
      <div class="px-4 pt-3">
        <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{preview.label || "Preview"}</p>
        <p class="mt-1 max-h-60 overflow-y-auto rounded-xl bg-zinc-950/3 px-3 py-2 text-base/6 whitespace-pre-wrap text-zinc-800 wrap-anywhere sm:text-sm/6 dark:bg-white/5 dark:text-zinc-200">{preview.value}</p>
      </div>
    {/if}
    {#if approval.status === "pending" && onanswer}
      <div class="flex flex-wrap items-center justify-end gap-2 px-4 pt-3 pb-3">
        <Button size="sm" variant="ghost" disabled={!open} loading={answering === "discard"} onclick={() => onanswer({ approve: false })}>Discard</Button>
        <Button size="sm" icon="pencil-square" disabled={!open} loading={answering === "edit"} onclick={edit}>Edit</Button>
        <Button size="sm" variant="primary" disabled={!open} loading={answering === "approve"} onclick={() => onanswer({ approve: true })}>Approve</Button>
      </div>
    {:else}
      <p class="flex items-center gap-1.5 px-4 pt-3 pb-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {#if approval.status === "approved"}<Icon name="check" class="size-4 fill-emerald-600 dark:fill-emerald-400" />{/if}
        {approval.status === "pending" ? "Waiting for approval." : outcome[approval.status]}
      </p>
    {/if}
  {/if}
</ChatCard>
