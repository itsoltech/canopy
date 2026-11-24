<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { create, equals } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { reflectionGatewayUpdate, reflectionWorkerForSave } from "@canopy/domain/reflection-models";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { HttpError } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import HabitReflectionFields from "./HabitReflectionFields.svelte";
  import HabitReviewDialog from "./HabitReviewDialog.svelte";
  import { resolveMemoryHabit, updateMemoryReflection } from "./habits-api.ts";
  import { habitRead, readHabitsOnEntry } from "./habit-suggestions.svelte.ts";
  import { habitExamples } from "./habits-format.ts";

  let { onapproved }: { onapproved: () => void } = $props();

  const overview = useOverview();
  const settingsSchema = ui.MemoryReflectionSettingsSchema;
  const defaults = create(settingsSchema, { intervalMinutes: 1440 });
  const lifetime = new AbortController();
  const suggestionsId = $props.id();
  const read = $derived(habitRead.snapshot);
  const snapshot = $derived(read.data ?? undefined);
  const loading = $derived(read.loading || (!read.loaded && !read.error));
  let baseline = untrack(() => editable(habitRead.data?.settings));
  let draft = $state.raw(baseline);
  let saving = $state(false);
  let valid = $state(false);
  let saveFailure = $state<{ conflict: boolean; invalid: boolean; detail: string }>();
  let review = $state.raw<ui.MemoryHabitSuggestion>();
  let reviewOpen = $state(false);
  let reviewKey = $state(0);
  let suggestionHeading = $state<HTMLHeadingElement>();
  const changed = $derived(!equals(settingsSchema, draft, editable(snapshot?.settings)));

  const workerId = $derived(snapshot && reflectionWorkerForSave(snapshot, draft, overview.ownProjects));
  const needsUpdate = $derived(changed && valid && workerId === undefined);

  const conflict = $derived(
    !!saveFailure?.conflict || (snapshot !== undefined && draft.revision !== (snapshot.settings?.revision ?? 0)),
  );

  function editable(settings = defaults) {
    const { enabled, intervalMinutes, projectIds, provider, profileId, model, effort, revision } = settings;

    return create(settingsSchema, {
      enabled,
      intervalMinutes: intervalMinutes || defaults.intervalMinutes,
      projectIds,
      provider,
      profileId: provider ? profileId || "native" : "",
      model,
      effort,
      revision,
    });
  }

  $effect(() => {
    if (!snapshot) return;
    const next = editable(snapshot.settings);

    untrack(() => {
      if (equals(settingsSchema, draft, baseline)) {
        draft = next;
        saveFailure = undefined;
      }

      baseline = next;
    });
  });

  async function load(resetDraft = false) {
    try {
      const next = await habitRead.reload();

      if (!lifetime.signal.aborted && next && resetDraft) {
        draft = editable(next.settings);
        saveFailure = undefined;
      }
    } catch {
      // The shared read exposes the load error beside the form.
    }
  }

  onMount(() => {
    void readHabitsOnEntry(lifetime.signal).catch(() => {});

    return () => lifetime.abort();
  });

  async function save() {
    if (!snapshot || workerId === undefined || !changed || !valid || loading || saving || conflict) return;
    saving = true;
    saveFailure = undefined;

    try {
      const settings = await updateMemoryReflection({ ...draft, workerId }, lifetime.signal);

      if (lifetime.signal.aborted) return;
      const current = habitRead.data;

      if (current && (current.settings?.revision ?? 0) <= settings.revision) habitRead.set({ ...current, settings });
      draft = editable(settings);
      await load(true);

      if (!lifetime.signal.aborted) toast("Habit settings saved");
    } catch (cause) {
      if (!lifetime.signal.aborted) {
        saveFailure = {
          conflict: cause instanceof HttpError && cause.status === 409,
          invalid: cause instanceof HttpError && cause.status === 400,
          detail: cause instanceof Error ? cause.message : "",
        };
      }
    } finally {
      if (!lifetime.signal.aborted) saving = false;
    }
  }

  async function resolve(approve: boolean, rule: string) {
    if (!review || !snapshot) return;
    const suggestion = review;
    await resolveMemoryHabit(suggestion, approve, rule, lifetime.signal);

    if (lifetime.signal.aborted) return;
    reviewOpen = false;
    const current = habitRead.data;

    if (current)
      habitRead.set({
        ...current,
        suggestions: current.suggestions.filter(
          (item) => item.id !== suggestion.id || item.revision !== suggestion.revision,
        ),
      });

    if (approve) onapproved();
    toast(approve ? (suggestion.suspended ? "Habit resumed" : "Habit saved as a project note") : "Suggestion rejected");
    void load();
    await tick();
    suggestionHeading?.focus({ preventScroll: true });
  }

  function inspect(suggestion: ui.MemoryHabitSuggestion) {
    review = suggestion;
    reviewKey += 1;
    reviewOpen = true;
  }

  function reloadSuggestions() {
    reviewOpen = false;
    void load();
  }
</script>

<SettingsGroup title="Habits">
  {#snippet actions()}
    <IconButton icon="arrow-path" label="Refresh habits" disabled={loading || saving} onclick={() => load()} />
    {#if snapshot}
      <Button
        variant="primary"
        class="min-w-32"
        loading={saving}
        disabled={loading || !changed || !valid || needsUpdate || conflict}
        onclick={save}>Save changes</Button
      >
    {/if}
  {/snippet}
  {#if snapshot}
    <HabitReflectionFields
      settings={snapshot.settings ?? defaults}
      bind:draft
      bind:valid
      projects={snapshot.projects}
      models={snapshot.models}
      usage={snapshot.usage}
      disabled={loading || saving || conflict}
    />
  {:else if loading}
    <p class="flex items-center justify-center gap-2 py-4 text-base/6 text-muted sm:text-sm/6" role="status">
      <Spinner />Loading habits…
    </p>
  {/if}
  {#if read.error && !read.loading}
    <div class="p-3">
      <Alert tone="error" title="Could not load habits">
        Check your connection.
        {#snippet actions()}<Button size="sm" onclick={() => load()}>Try again</Button>{/snippet}
      </Alert>
    </div>
  {/if}
  {#if conflict}
    <div class="p-3">
      <Alert tone="warning" title="Habit settings changed">
        Reload the settings, then reapply your changes.
        {#snippet actions()}<Button size="sm" disabled={loading} onclick={() => load(true)}>Reload settings</Button
          >{/snippet}
      </Alert>
    </div>
  {:else if needsUpdate}
    <div class="p-3"><Alert tone="warning" title="Gateway update needed">{reflectionGatewayUpdate}</Alert></div>
  {:else if saveFailure}
    <div class="p-3">
      <Alert tone="error" title="Could not save habit settings">
        {saveFailure.invalid
          ? "Check the selected projects, model and reasoning effort."
          : "Check your connection and try again."}
        {#if saveFailure.detail}
          <Disclosure class="mt-2">
            {#snippet summary()}Show details{/snippet}
            <div class="mt-1 flex min-w-0 items-start gap-2">
              <p class="min-w-0 flex-1 wrap-anywhere select-text">{saveFailure.detail}</p>
              <CopyButton text={saveFailure.detail} label="Copy error details" />
            </div>
          </Disclosure>
        {/if}
      </Alert>
    </div>
  {/if}
</SettingsGroup>
{#if snapshot}
  <section aria-labelledby={suggestionsId}>
    <h2
      id={suggestionsId}
      bind:this={suggestionHeading}
      tabindex="-1"
      class="settings-group-header mb-3 w-fit rounded-sm px-1 text-base/7 font-semibold focus-ring"
    >
      Suggestions
    </h2>
    <SettingsCard>
      {#if snapshot.suggestions.length}
        <ul role="list" class="divide-y divide-divider">
          {#each snapshot.suggestions as suggestion (suggestion.id)}
            <li>
              <button
                type="button"
                class="settings-row flex w-full min-w-0 items-center gap-3 px-3 py-2 text-start focus-ring hover:bg-zinc-950/5 focus-visible:-outline-offset-2 dark:hover:bg-white/5"
                onclick={() => inspect(suggestion)}
              >
                <span class="grid min-w-0 flex-1 grid-cols-1">
                  <TruncatedText text={suggestion.rule} class="text-base/6 font-medium sm:text-sm/6" />
                  <span class="flex min-w-0 items-center gap-2">
                    <TruncatedText text={suggestion.projectName} class="text-sm/5 text-muted" />
                    {#if suggestion.suspended}<Badge compact tone="amber">Suspended</Badge>{/if}
                  </span>
                </span>
                <span class="shrink-0 text-sm/5 text-muted tabular-nums">{habitExamples(suggestion.evidenceCount)}</span
                >
                <Icon name="chevron-right" />
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="settings-row px-3 py-2 text-base/6 text-muted sm:text-sm/6">No suggestions to review</p>
      {/if}
    </SettingsCard>
  </section>
{/if}

{#if review}
  {#key reviewKey}
    <HabitReviewDialog suggestion={review} bind:open={reviewOpen} onresolve={resolve} onreload={reloadSuggestions} />
  {/key}
{/if}
