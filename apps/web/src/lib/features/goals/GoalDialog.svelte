<script lang="ts">
  import { Provider, type ui } from "@open-agents/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { setGoal } from "./api.ts";
  import { isFinishedGoal, OBJECTIVE_LIMIT, takesTokenBudget } from "./goals.ts";

  /**
   * Sets the thread's goal: what has to be true when the agent is done and, for Codex, an optional
   * token budget (Claude Code's `/goal` has none). A new goal replaces the open one. `onset` gets the
   * goal the gateway stored.
   */
  let {
    open = $bindable(false),
    threadId,
    provider,
    current,
    onset,
  }: { open?: boolean; threadId: string; provider: Provider; current: ui.Goal | undefined; onset?: ((goal: ui.Goal) => void) | undefined } = $props();

  const budgeted = $derived(takesTokenBudget(provider));
  const replacing = $derived(current && !isFinishedGoal(current.status) ? current : undefined);
  const how = $derived(
    provider === Provider.CLAUDE
      ? "Claude checks the goal after each turn and keeps working until it is met. Pausing interrupts the running turn."
      : "Codex keeps starting turns on its own until the goal is met, blocked or out of budget.",
  );

  let objective = $state("");
  // A number input binds a number (null when empty).
  let budget = $state<number | null>(null);
  let busy = $state(false);
  let error = $state<string>();
  const tokens = $derived(budget ?? 0);
  const budgetError = $derived(budgeted && (!Number.isSafeInteger(tokens) || tokens < 0) ? "Enter a whole number of tokens, or leave it empty for no limit." : undefined);

  $effect(() => {
    if (!open) return;
    objective = "";
    budget = null;
    error = undefined;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!objective.trim() || budgetError) return;
    busy = true;
    error = undefined;
    try {
      const goal = await setGoal(threadId, "set", { objective: objective.trim(), ...(budgeted && tokens > 0 && { tokenBudget: tokens }) });
      if (goal) onset?.(goal);
      open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Setting the goal failed";
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title={replacing ? "Replace the goal" : "Set a goal"} description={how}>
  <form class="grid gap-5" onsubmit={submit} novalidate>
    {#if replacing}
      <Alert tone="info">This replaces the current goal: “{replacing.objective.length > 160 ? `${replacing.objective.slice(0, 160)}…` : replacing.objective}”</Alert>
    {/if}
    <Field label="Goal" description="What has to be true when the agent is done. Be specific about how to check it.">
      <Textarea name="objective" rows={4} maxlength={OBJECTIVE_LIMIT} required placeholder="All tests in packages/api pass and the build is green" bind:value={objective} data-autofocus />
    </Field>
    {#if budgeted}
      <Field label="Token budget" optional description="Codex stops working on the goal once it has used this many tokens." error={budgetError}>
        <Input name="tokenBudget" type="number" inputmode="numeric" min="0" step="1000" placeholder="No limit" bind:value={budget} />
      </Field>
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" icon="flag" loading={busy} disabled={!objective.trim() || Boolean(budgetError)}>{replacing ? "Replace goal" : "Set goal"}</Button>
    </DialogActions>
  </form>
</Dialog>
