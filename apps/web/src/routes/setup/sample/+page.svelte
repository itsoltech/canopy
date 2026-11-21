<script lang="ts">
  import { goto } from "$app/navigation";
  import { create, toJsonString } from "@bufbuild/protobuf";
  import { PermissionMode, Provider, ui } from "@canopy/contracts";
  import { hasComposerContent } from "@canopy/domain/composer-drafts";
  import { limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { webDrafts } from "#lib/features/drafts/local.svelte.ts";
  import type { WebComposerDraft } from "#lib/features/drafts/state.svelte.ts";
  import type { ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { newThreadModel } from "#lib/features/models/new-thread-model.ts";
  import SetupDetailPage from "#lib/features/onboarding/SetupDetailPage.svelte";
  import { setupAgentModels, setupAgentRows } from "#lib/features/onboarding/setup-agent.ts";
  import { chooseSetupWorker, setupThreadHref } from "#lib/features/onboarding/setup-state.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { effectiveDefaults } from "#lib/features/settings/thread-defaults.ts";
  import { cliLabel } from "#lib/features/workers/cli-tools.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";

  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const settings = useSettings();
  const catalog = useModelCatalog();
  const localDesktop = $derived(capabilities?.localDesktop ?? false);
  const workers = $derived(overview.ownWorkers.filter((worker) => !worker.revokedAt));

  const worker = $derived(
    chooseSetupWorker(overview.ownWorkers, devicePreferences.view.onboardingWorkerId, catalog, localDesktop),
  );

  const project = $derived(overview.projectChoices.find((project) => project.kind === "scratch"));
  const workspace = $derived(project?.workspaces.find((workspace) => workspace.workerId === worker?.id));
  const workerCatalog = $derived(worker && catalog.of(worker.id));
  const options = $derived(setupAgentModels(worker, workerCatalog));

  const defaults = $derived(
    effectiveDefaults(settings.threadDefaults, project ? settings.projectDefaults(project.id) : undefined),
  );

  const model = $derived(newThreadModel(options, defaults, overview.threads.values()).option);

  const draft = $derived.by(() => {
    void webDrafts.generation;
    const scope = capabilities?.clientPreferencesScope;

    if (workspace && scope && webDrafts.ready && webDrafts.scope === scope) {
      return webDrafts.get(
        create(ui.ComposerDraftTargetSchema, { projectId: workspace.projectId, workspaceId: workspace.id }),
        () => limitsOf(settings.attachmentLimits),
      );
    }

    return undefined;
  });

  function agentBlocker(worker: ui.Worker) {
    const rows = setupAgentRows(worker, workerCatalog);
    const providerHref = `/settings/providers?worker=${encodeURIComponent(worker.id)}`;
    const login = rows.find((row) => row.status === "signed_out" || row.status === "expired");

    if (login?.instance) {
      const name = cliLabel(Provider[login.provider]);

      return {
        text:
          login.status === "expired"
            ? `The ${name} sign-in on “${worker.name}” expired or was rejected.`
            : `Sign in to ${name} on “${worker.name}” to use it here.`,
        label: "Open provider settings",
        href: `${providerHref}&instance=${encodeURIComponent(instanceKeyOf(login.instance))}`,
      };
    }

    if (rows.some((row) => row.status === "missing_cli")) {
      return {
        text: `Install an agent CLI on “${worker.name}” to use it here.`,
        label: "Open worker settings",
        href: `/settings/workers/${encodeURIComponent(worker.id)}#agent-clis`,
      };
    }

    return {
      text: `“${worker.name}” has no available model. Check its provider settings.`,
      label: "Open provider settings",
      href: providerHref,
    };
  }

  type Blocker = { text: string; href?: string; label?: string; retry?: boolean };

  const blocker = $derived.by((): Blocker | undefined => {
    if (overview.connection === "unavailable") {
      return { text: "Canopy could not connect to the gateway. Check the connection, then retry.", retry: true };
    }

    if (overview.connection !== "live" || !settings.loaded) return { text: "Checking setup…" };

    if (!settings.moduleEnabled("threads")) {
      return {
        text: "Threads is off. Turn it on to try this example.",
        label: "Open settings",
        href: "/settings/general",
      };
    }

    if (!worker) {
      return localDesktop
        ? { text: "Waiting for the local worker…" }
        : {
            text: "A worker runs agents on a computer you choose.",
            label: "Add worker",
            href: "/settings/workers?add=1",
          };
    }

    const workerHref = `/settings/workers/${encodeURIComponent(worker.id)}`;

    if (!worker.online) {
      return workers.some((candidate) => candidate.online)
        ? { text: `“${worker.name}” is offline. Choose another worker.` }
        : {
            text: `“${worker.name}” is offline. Start it to try this example.`,
            label: "Open worker settings",
            href: workerHref,
          };
    }

    if (!workspace) {
      return {
        text: `The sample workspace on “${worker.name}” is unavailable.`,
        label: "Open worker settings",
        href: workerHref,
      };
    }

    if (!draft || catalog.refreshing.has(worker.id)) return { text: "Checking setup…" };

    return model ? undefined : agentBlocker(worker);
  });

  const message =
    "Write a test plan for the bug report below. List 3 test cases and 2 questions to ask before fixing it.\n\n" +
    "On a phone, rotating the screen clears the text in the search field. It happens before and after search results appear. The query should stay in the field.";

  let confirmation = $state.raw<{ draft: WebComposerDraft; fingerprint: string }>();
  let opening = $state(false);
  let error = $state("");

  function draftBlocker(draft: WebComposerDraft) {
    if (draft.pendingForm || draft.pendingSend) return "This draft already has a pending message.";

    if (draft.locked || draft.reconciling) return "This draft has an action in progress.";

    if (draft.files.files.some((file) => file.status === "uploading")) return "Wait for the files to upload.";

    return draft.files.blocker;
  }

  const protectedDraft = $derived(draft && draftBlocker(draft));
  const canOpenExisting = $derived(Boolean(protectedDraft && settings.loaded && settings.moduleEnabled("threads")));

  function fingerprint(draft: WebComposerDraft, content = draft.content()) {
    return JSON.stringify([
      toJsonString(ui.ComposerDraftContentSchema, content),
      draft.files.files.map((file) => [file.key, file.status]),
    ]);
  }

  async function openComposer(workspace: ui.Workspace) {
    opening = true;
    error = "";

    try {
      await goto(setupThreadHref(workspace));
    } catch {
      error = "Could not open the draft. Try again.";
    } finally {
      opening = false;
    }
  }

  function seedDraft(draft: WebComposerDraft, workspace: ui.Workspace, model: ModelOption) {
    draft.restore({
      text: message,
      mentions: [],
      quotes: [],
      files: [],
      choices: {
        provider: Provider[model.provider],
        providerProfileId: model.profileId,
        model: model.model,
        permissionMode: PermissionMode.READ_ONLY,
      },
    });
    // restore persists the draft. Flush the local write before handing it to the composer.
    draft.local.flush();
    void openComposer(workspace);
  }

  function openSample() {
    if (opening || !workspace || !draft || draft.retired) return;
    error = "";

    if (canOpenExisting) {
      void openComposer(workspace);

      return;
    }

    if (blocker || !model) return;
    draft.activate();
    const content = draft.content();
    const { model: chosenModel, effort, serviceTier, permissionMode, provider, providerProfileId } = draft.choices;

    if (
      hasComposerContent(content, draft.files.files.length) ||
      chosenModel !== undefined ||
      effort !== undefined ||
      serviceTier !== undefined ||
      permissionMode !== undefined ||
      provider ||
      providerProfileId
    ) {
      confirmation = { draft, fingerprint: fingerprint(draft, content) };

      return;
    }

    seedDraft(draft, workspace, model);
  }

  function resolveConfirmation(replace: boolean) {
    const shown = confirmation;
    confirmation = undefined;

    if (!shown || opening || !draft || !workspace || draft.retired || shown.draft !== draft) {
      error = "The draft changed. Open it again to review the latest version.";

      return;
    }

    if (!replace || draftBlocker(draft)) {
      void openComposer(workspace);

      return;
    }

    if (blocker || !model) return;

    if (shown.fingerprint !== fingerprint(draft)) {
      error = "The draft changed. Open it again to review the latest version.";

      return;
    }

    seedDraft(draft, workspace, model);
  }
</script>

<SetupDetailPage
  title="Turn a bug report into a test plan"
  description="Get a test checklist from a sample bug report."
>
  <section class="grid gap-3" aria-labelledby="sample-requirements">
    <div class="grid gap-1">
      <h2 id="sample-requirements" class="text-lg/7 font-medium text-ink">What you need</h2>
      <p class="text-base/6 text-muted sm:text-sm/6">An online worker and an available agent.</p>
    </div>
    {#if worker}
      <div class="grid gap-1">
        {#if workers.length > 1}
          <div class="w-full min-w-0 sm:max-w-80">
            <Select
              aria-label="Choose a worker"
              aria-describedby="sample-worker-description"
              value={worker.id}
              options={workers.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
                description: candidate.online ? "Connected" : "Offline",
              }))}
              onchange={(onboardingWorkerId) => devicePreferences.setView({ onboardingWorkerId })}
            />
          </div>
        {:else}
          <p class="text-base/6 font-medium wrap-anywhere text-ink sm:text-sm/6">Worker · {worker.name}</p>
        {/if}
        <p id="sample-worker-description" class="text-base/6 text-muted sm:text-sm/6">
          The agent runs on the computer you choose.
        </p>
      </div>
    {/if}
    <div class="grid gap-2">
      <p class="min-h-6 text-base/6 wrap-anywhere text-muted sm:text-sm/6" role="status">
        {protectedDraft && canOpenExisting ? protectedDraft : (blocker?.text ?? "The sample uses Read only access.")}
      </p>
      <div class="flex min-h-10 flex-wrap items-start gap-2 sm:min-h-9">
        {#if canOpenExisting || !blocker}
          <Button variant="primary" loading={opening} onclick={openSample}>
            {canOpenExisting ? "Open existing draft" : "Open thread draft"}
          </Button>
        {:else if blocker.href && blocker.label}
          <ButtonLink variant="primary" href={blocker.href}>{blocker.label}</ButtonLink>
        {:else if blocker.retry}
          <Button variant="primary" onclick={() => location.reload()}>Retry</Button>
        {/if}
      </div>
    </div>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
  </section>

  <section class="grid gap-3 rounded-lg border border-divider p-4 sm:p-5" aria-labelledby="sample-result">
    <div class="grid gap-1">
      <h2 id="sample-result" class="text-lg/7 font-medium text-ink">Sample result</h2>
      <p class="text-sm/5 text-muted sm:text-xs/5">This result uses fictional data.</p>
    </div>
    <ol class="list-decimal space-y-1 pl-5 text-base/6 text-ink sm:text-sm/6">
      <li>Rotate the phone while typing. The search field should keep the query.</li>
      <li>Rotate after results load. The query and results should stay visible.</li>
      <li>Rotate back. The query should still be in the field.</li>
    </ol>
    <p class="text-base/6 text-ink sm:text-sm/6">Which phones are affected? Does it happen in both directions?</p>
  </section>
  <p class="text-base/6 sm:text-sm/6"><TextLink href="/setup/privacy">Learn about privacy</TextLink></p>
</SetupDetailPage>

<Dialog
  bind:open={
    () => Boolean(confirmation),
    (open) => {
      if (!open) confirmation = undefined;
    }
  }
  title="Replace this draft?"
  description="This replaces the unsent message, its attachments and draft settings."
>
  <DialogActions>
    <Button data-autofocus onclick={() => resolveConfirmation(false)}>Keep draft</Button>
    <Button variant="danger" onclick={() => resolveConfirmation(true)}>Replace draft</Button>
  </DialogActions>
</Dialog>
