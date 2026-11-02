<script lang="ts">
  import { Provider, type ui } from "@open-agents/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ChoiceCard from "#lib/shared/ui/ChoiceCard.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { pageSlide } from "#lib/shared/ui/motion.ts";
  import AccentPicker from "./AccentPicker.svelte";
  import ConnectionFields from "./ConnectionFields.svelte";
  import InstanceMark from "./InstanceMark.svelte";
  import { draftProblems, harnessName, idFromLabel, newDraft, providerCall, saveRequest, type DraftProblems } from "./instances.ts";
  import RuntimeFields from "./RuntimeFields.svelte";
  import WorkersField from "./WorkersField.svelte";

  /**
   * "Add provider" (T3 wizard): 1 Provider (the harnesses we run: Codex, Claude Code), 2 Identity (label, instance id,
   * optional accent color), 3 Config (connection, where it runs, runtime and launch arguments). Steps slide side by
   * side (motion.ts `pageSlide`). A Codex instance with its own login signs in from its detail once it runs.
   */
  let {
    open = $bindable(false),
    instances,
    workers,
    scope,
    onadded,
  }: {
    open?: boolean;
    instances: readonly ui.ProviderInstance[];
    workers: readonly ui.Worker[];
    /** The page's worker: the new instance runs there (else on all workers). */
    scope: string | undefined;
    onadded: (instance: ui.ProviderInstance | undefined) => void;
  } = $props();

  const steps = ["Provider", "Identity", "Config"] as const;
  let step = $state(0);
  let direction = $state(1);
  let draft = $state(newDraft(Provider.CODEX, []));
  let tried = $state<number>(-1);
  let busy = $state(false);
  let failure = $state<string>();
  $effect.pre(() => {
    if (!open) return;
    step = 0;
    draft = newDraft(Provider.CODEX, scope ? [scope] : []);
    tried = -1;
    failure = undefined;
  });

  const taken = $derived(new Set(instances.filter((i) => i.harness === draft.harness).map((i) => i.id)));
  const problems = $derived(draftProblems(draft, { builtIn: false, creating: true, takenIds: taken }));
  /** Problems of the current step only, once the user tried to go on. */
  const shown = $derived<DraftProblems>(
    tried < step ? { env: {} } : step === 1 ? { env: {}, ...(problems.label && { label: problems.label }), ...(problems.id && { id: problems.id }) } : step === 2 ? problems : { env: {} },
  );
  const stepBlocked = (s: number) => (s === 1 ? Boolean(problems.label || problems.id) : s === 2 ? Boolean(problems.baseUrl || problems.apiKey || problems.workers) : false);

  function go(to: number) {
    direction = to > step ? 1 : -1;
    step = to;
  }

  function next() {
    tried = step;
    if (stepBlocked(step)) return;
    go(step + 1);
  }

  function setLabel(label: string) {
    draft.label = label;
    if (!draft.idEdited) draft.id = idFromLabel(label);
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (step < 2) return next();
    tried = 2;
    if (stepBlocked(1)) return go(1);
    if (stepBlocked(2)) return;
    busy = true;
    failure = undefined;
    try {
      const saved = await providerCall("save", saveRequest(draft, { creating: true, expectedRevision: 0n }));
      open = false;
      onadded(saved.instance);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  const harnesses = [
    { value: Provider.CODEX, description: "OpenAI's coding agent (codex app-server)." },
    { value: Provider.CLAUDE, description: "Anthropic's Claude Code (Agent SDK)." },
    { value: Provider.GROK, description: "xAI's Grok CLI (Agent Client Protocol)." },
  ];
</script>

<Dialog bind:open title="Add provider" description="Defined once, synced to the workers you choose." size="lg">
  <form class="grid gap-6" onsubmit={add} novalidate>
    <ol role="list" class="flex items-center gap-2 text-sm/5 sm:text-xs/5">
      {#each steps as label, i (label)}
        <li class="flex min-w-0 items-center gap-2">
          {#if i > 0}<span class="h-px w-4 shrink-0 bg-zinc-950/10 dark:bg-white/10" aria-hidden="true"></span>{/if}
          <span
            class={[
              "grid size-6 shrink-0 place-items-center rounded-full font-medium sm:size-5",
              i <= step ? "bg-brand-600 text-white dark:bg-brand-500" : "bg-zinc-950/5 text-zinc-500 dark:bg-white/8 dark:text-zinc-400",
            ]}
            aria-hidden="true">{i + 1}</span
          >
          <span class={["truncate", i === step ? "font-medium text-zinc-950 dark:text-white" : "text-zinc-500 dark:text-zinc-400"]} aria-current={i === step ? "step" : undefined}>{label}</span>
        </li>
      {/each}
    </ol>

    <div class="grid">
      {#key step}
        <div class="col-start-1 row-start-1 grid min-w-0 gap-5" in:pageSlide={{ step: direction }} out:pageSlide={{ step: direction }}>
          {#if step === 0}
            <fieldset class="grid gap-2">
              <legend class="sr-only">Provider</legend>
              {#each harnesses as h (h.value)}
                <ChoiceCard name="harness" checked={draft.harness === h.value} title={harnessName(h.value)} description={h.description} onchange={() => (draft.harness = h.value)}>
                  {#snippet leading()}<InstanceMark instance={{ harness: h.value, accentColor: "" }} class="size-9" />{/snippet}
                </ChoiceCard>
              {/each}
            </fieldset>
          {:else if step === 1}
            <div class="grid gap-4 sm:grid-cols-2">
              <Field label="Label" error={shown.label}>
                <Input name="label" bind:value={() => draft.label, setLabel} placeholder="Team proxy" autocomplete="off" data-autofocus />
              </Field>
              <Field label="Instance ID" description="Lowercase letters, digits, - and _. Threads store it; it cannot change." error={shown.id}>
                <Input name="id" bind:value={() => draft.id, (id: string) => ((draft.id = id.toLowerCase()), (draft.idEdited = true))} placeholder="team-proxy" autocomplete="off" spellcheck="false" class="font-mono" />
              </Field>
            </div>
            <AccentPicker name="new-accent" bind:value={draft.accentColor} />
          {:else}
            <ConnectionFields
              harness={draft.harness}
              bind:kind={draft.kind}
              bind:baseUrl={draft.baseUrl}
              apiKeySet={false}
              bind:keyAction={draft.keyAction}
              bind:apiKey={draft.apiKey}
              bind:ownLogin={draft.ownLogin}
              errors={shown}
              prefix="new"
            />
            <WorkersField {workers} allWorkers={draft.allWorkers} workerIds={draft.workerIds} error={shown.workers} onchange={(w) => ((draft.allWorkers = w.allWorkers), (draft.workerIds = w.workerIds))} />
            <Disclosure summaryClass="text-base/6 font-medium sm:text-sm/6">
              {#snippet summary()}Runtime and launch arguments{/snippet}
              <div class="pt-3">
                <RuntimeFields harness={draft.harness} bind:binaryPath={draft.binaryPath} bind:homePath={draft.homePath} bind:shadowHomePath={draft.shadowHomePath} bind:launchArgs={draft.launchArgs} prefix="new" />
              </div>
            </Disclosure>
            {#if draft.harness === Provider.CLAUDE}
              <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">Claude Code has no sign-in through its API: use the device's login, a key in the variables, or an endpoint.</p>
            {/if}
          {/if}
        </div>
      {/key}
    </div>

    {#if failure}<Alert tone="error">{failure}</Alert>{/if}
    <DialogActions>
      {#if step > 0}<Button variant="ghost" onclick={() => go(step - 1)}>Back</Button>{:else}<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>{/if}
      <Button type="submit" variant="primary" loading={busy}>{step < 2 ? "Continue" : "Add instance"}</Button>
    </DialogActions>
  </form>
</Dialog>
