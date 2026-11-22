<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { HttpError } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { habitExamples } from "./habits-format.ts";

  let {
    suggestion,
    open = $bindable(),
    onresolve,
    onreload,
  }: {
    suggestion: ui.MemoryHabitSuggestion;
    open: boolean;
    onresolve: (approve: boolean, rule: string) => Promise<void>;
    onreload: () => void;
  } = $props();

  let rule = $state(untrack(() => suggestion.rule));
  let rejecting = $state(false);
  let busy = $state(false);
  let failure = $state<{ stale: boolean; detail: string }>();
  const id = $props.id();

  const sources = $derived([
    ...new Map(suggestion.evidence.filter((item) => item.threadId).map((item) => [item.threadId, item])).values(),
  ]);

  const reviewTitle = $derived(suggestion.suspended ? "Review suspended habit" : "Review suggestion");
  const approveLabel = $derived(suggestion.suspended ? "Resume habit" : "Approve");

  const approveError = $derived(
    suggestion.suspended ? "Could not resume the habit" : "Could not approve the suggestion",
  );

  async function showReject(show: boolean) {
    rejecting = show;
    failure = undefined;
    await tick();
    document.getElementById(`${id}-${show ? "cancel" : "reject"}`)?.focus();
  }

  async function resolve(approve: boolean) {
    if (busy || failure?.stale || (approve && !rule.trim())) return;
    busy = true;
    failure = undefined;

    try {
      await onresolve(approve, rule);
    } catch (cause) {
      failure = {
        stale: cause instanceof HttpError && [404, 409].includes(cause.status),
        detail: cause instanceof Error ? cause.message : "",
      };
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  dismissible={!busy}
  title={rejecting ? "Reject suggestion?" : reviewTitle}
  description={suggestion.projectName}
>
  <div class="grid min-w-0 gap-4">
    {#if rejecting}
      <p class="text-base/6 sm:text-sm/6">
        Canopy removes this suggestion and skips the same examples in future checks.
      </p>
    {:else}
      <Field label="Rule">
        <Textarea name="habit-rule" bind:value={rule} maxlength={240} rows={3} disabled={busy} />
      </Field>
      <div class="grid min-w-0 gap-1 text-base/6 sm:text-sm/6">
        <h3 class="font-medium">{habitExamples(suggestion.evidenceCount)}</h3>
        {#if sources.length}
          <ul role="list" class="grid min-w-0 gap-1 text-muted">
            {#each sources as source (source.threadId)}
              <li class="min-w-0">
                <a
                  href={`/threads/${encodeURIComponent(source.threadId)}`}
                  class="rounded-sm wrap-anywhere underline underline-offset-2 focus-ring"
                >
                  {source.title || "Untitled thread"}
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    {#if failure?.stale}
      <Alert tone="warning" title="This suggestion changed">
        Copy any edits you want to keep before reloading suggestions.
      </Alert>
    {:else if failure}
      <Alert tone="error" title={rejecting ? "Could not reject the suggestion" : approveError}>
        Check the details and try again.
        {#if failure.detail}
          <Disclosure class="mt-2">
            {#snippet summary()}Show details{/snippet}
            <div class="mt-1 flex min-w-0 items-start gap-2">
              <p class="min-w-0 flex-1 wrap-anywhere select-text">{failure.detail}</p>
              <CopyButton text={failure.detail} label="Copy error details" />
            </div>
          </Disclosure>
        {/if}
      </Alert>
    {/if}
  </div>
  {#snippet footer()}
    <DialogActions>
      {#if failure?.stale}
        <Button variant="primary" onclick={onreload}>Reload suggestions</Button>
      {:else if rejecting}
        <Button id={`${id}-cancel`} disabled={busy} onclick={() => showReject(false)}>Cancel</Button>
        <Button variant="danger" loading={busy} onclick={() => resolve(false)}>Reject suggestion</Button>
      {:else}
        <Button id={`${id}-reject`} disabled={busy} onclick={() => showReject(true)}>Reject</Button>
        <Button variant="primary" loading={busy} disabled={!rule.trim()} onclick={() => resolve(true)}
          >{approveLabel}</Button
        >
      {/if}
    </DialogActions>
  {/snippet}
</Dialog>
