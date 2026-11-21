<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { onMount } from "svelte";
  import type {
    DesktopMigrationApproval,
    DesktopMigrationBridge,
    DesktopMigrationStatus,
    DesktopMigrationTarget,
    DesktopStatus,
  } from "@canopy/ui/desktop";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import Toaster from "#lib/shared/ui/Toaster.svelte";
  import MigrationTargetForm from "#lib/features/desktop/migration/MigrationTargetForm.svelte";
  import MigrationTrial from "#lib/features/desktop/migration/MigrationTrial.svelte";
  import MigrationPeers from "#lib/features/desktop/migration/MigrationPeers.svelte";
  import MigrationApproval from "#lib/features/desktop/migration/MigrationApproval.svelte";
  import { progressTitle } from "#lib/features/desktop/migration/migration-copy.ts";

  const actionCopy = {
    prepare: { pending: "Running migration trial…", failed: "Could not start the trial" },
    activate: { pending: "Preparing the next migration step…", failed: "Could not finish this step" },
    recover: { pending: "Checking both gateways…", failed: "Could not recover the migration" },
    abort: { pending: "Canceling the migration…", failed: "Could not cancel the migration" },
  };

  type Action = keyof typeof actionCopy;

  let migration = $state.raw<DesktopMigrationBridge>();
  let desktop = $state.raw<DesktopStatus>();
  let status = $state.raw<DesktopMigrationStatus>();
  let mounted = $state(false);
  let statusFailed = $state(false);
  let desktopRead = $state(false);
  let busy = $state<Action>();
  let failure = $state<Action>();
  let selectedPeers = $state.raw<readonly string[]>([]);
  let revision = 0;
  let reading = false;

  const ready = $derived(mounted && Boolean(migration) && Boolean(status));
  const phase = $derived(status?.phase);
  const joining = $derived(status?.kind === "join");
  const review = $derived(status?.preparation?.review);
  const finalReview = $derived(phase === "fenced" && joining ? review : undefined);
  const blocked = $derived(Boolean(review?.blockers.length));

  const missingReview = $derived(
    joining && !review && (phase === "prepared" || (phase === "fenced" && !status?.canRecover)),
  );

  const peers = $derived(status?.preparation?.peers ?? []);

  const canStart = $derived(
    (desktop?.configuration?.mode ?? desktop?.mode) === "local" && desktop?.phase === "running",
  );

  const canAct = $derived(!busy && !statusFailed);
  const canStage = $derived(phase === "prepared" && Boolean(status?.kind) && !blocked && !missingReview);
  const canLeave = $derived(migration && !busy && (phase === "idle" || !status));
  const running = $derived(desktop?.phase === "running");
  const progress = $derived(!missingReview && !finalReview && phase ? progressTitle[phase] : undefined);
  const progressText = $derived(progress ?? (busy ? actionCopy[busy].pending : undefined));
  const stageVerb = $derived(joining ? "Pause for review" : "Switch gateway");

  async function refresh() {
    if (!migration || reading) return;
    const current = revision;
    reading = true;

    try {
      const next = await migration.status();

      if (mounted && current === revision) {
        status = next;
        statusFailed = false;
      }
    } catch {
      if (mounted && current === revision) statusFailed = true;
    } finally {
      reading = false;
    }
  }

  onMount(() => {
    const bridge = window.canopyDesktop;
    mounted = true;
    migration = bridge?.gatewayMigration;

    if (!migration || !bridge) return;

    const updateDesktop = (value: DesktopStatus) => {
      desktop = value;
      desktopRead = true;
    };

    const stop = bridge.onStatus(updateDesktop);
    void bridge.status().then(
      (value) => {
        if (mounted && !desktopRead) updateDesktop(value);
      },
      () => (desktopRead = true),
    );
    void refresh();

    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 1200);

    return () => {
      mounted = false;
      ++revision;
      stop();
      clearInterval(timer);
    };
  });

  async function run(action: Action, operation: () => Promise<DesktopMigrationStatus>) {
    if (!canAct) return;
    ++revision;
    failure = undefined;
    busy = action;

    try {
      const next = await operation();
      ++revision;

      if (mounted) {
        status = next;
        statusFailed = false;
      }
    } catch {
      ++revision;

      if (mounted) {
        failure = action;
        statusFailed = true;
      }
    } finally {
      busy = undefined;

      if (mounted) void refresh();
    }
  }

  function prepare(target: DesktopMigrationTarget) {
    const bridge = migration;

    if (!bridge || !canStart || phase !== "idle" || !canAct) return;
    selectedPeers = [];
    void run("prepare", () => bridge.prepare(target));
  }

  function approve(approval: DesktopMigrationApproval) {
    const bridge = migration;

    if (!bridge || !finalReview || blocked || finalReview.reviewDigest !== approval.reviewDigest) return;
    void run("activate", () => bridge.activate(approval));
  }

  function stage() {
    const bridge = migration;

    if (bridge && canStage) {
      const selection = joining ? undefined : [...selectedPeers];
      void run("activate", () => bridge.activate(undefined, selection));
    }
  }

  function recover() {
    const bridge = migration;

    if (bridge && status?.canRecover) void run("recover", () => bridge.recover());
  }

  function abort() {
    const bridge = migration;

    if (bridge && status?.canAbort) void run("abort", () => bridge.abort());
  }
</script>

<svelte:head><title>Gateway migration · {applicationName}</title></svelte:head>
<div class="fixed inset-x-0 top-0 hidden h-12 desktop:block" data-window-drag></div>
<main class="isolate min-h-dvh bg-canvas pt-[max(3rem,var(--window-safe-top))] pb-10 text-ink">
  <div class="mx-auto grid w-full max-w-3xl min-w-0 gap-6 px-5 text-base/6 sm:px-8 sm:text-sm/6">
    <header class="grid gap-3">
      {#if canLeave && mounted}
        <div>
          <ButtonLink href={running ? "/settings/desktop" : "/desktop"} variant="ghost" icon="arrow-left"
            >{running ? "Back to Desktop settings" : "Back to startup"}</ButtonLink
          >
        </div>
      {/if}
      <div class="grid gap-2">
        <h1 class="text-2xl/8 font-semibold tracking-tight text-balance sm:text-3xl/9">Gateway migration</h1>
        {#if status?.target}
          <p class="wrap-anywhere text-muted">Server <span class="font-medium text-ink">{status.target}</span></p>
        {/if}
      </div>
    </header>

    {#if mounted && !migration}
      <Alert title="Open Canopy Desktop">Run a migration from the Canopy desktop app in Local mode.</Alert>
    {:else if statusFailed && !ready}
      <Alert title="Could not read the migration status" tone="error">Check the status before continuing.</Alert>
      <div><Button onclick={() => void refresh()}>Check status</Button></div>
    {:else if !ready || (phase === "idle" && !desktopRead)}
      <p class="flex items-center gap-3 text-muted" role="status">
        <Spinner />Checking migration status…
      </p>
    {:else}
      {#if statusFailed}
        <Alert title="Could not read the migration status" tone="error">Check the status before continuing.</Alert>
      {:else if failure && !status?.error}
        <Alert title={actionCopy[failure].failed} tone="error">
          {phase === "idle"
            ? "Check SSH access and the server’s migration setup, then run the trial again."
            : "Review the current step before continuing."}
        </Alert>
      {/if}

      {#if phase === "idle"}
        {#if canStart}<MigrationTargetForm onprepare={prepare} disabled={!canAct} />
        {:else}<Alert title="Start Canopy in Local mode">
            Wait for the local gateway to start before running a trial.
          </Alert>{/if}
      {:else if phase === "prepared" && !missingReview}
        <MigrationTrial preparation={status?.preparation} {joining} />
        <MigrationPeers {peers} view={joining ? "affected" : "plan"} bind:selected={selectedPeers} />
      {:else if finalReview}
        {#key finalReview.reviewDigest}<MigrationApproval
            review={finalReview}
            enabled={canAct}
            canAbort={Boolean(status?.canAbort)}
            onapprove={approve}
          />{/key}
      {:else if phase === "completed"}
        <section class="grid gap-3" aria-labelledby="migration-complete">
          <div class="grid gap-1">
            <h2 class="text-lg/7 font-semibold" id="migration-complete">Migration complete</h2>
            <p class="text-pretty text-muted">
              This computer now uses the server in Remote mode. Your worker still runs here.
            </p>
          </div>
          <div><ButtonLink href="/" variant="primary">Open Canopy</ButtonLink></div>
        </section>
        <MigrationPeers {peers} view="follow-up" selected={status?.preparation?.selectedPeerIds ?? selectedPeers} />
      {/if}

      {#if missingReview && !busy && !statusFailed}
        <Alert title="Could not read the import review" tone="error">
          Cancel this attempt and check the shared server’s migration setup before running a new trial.
        </Alert>
      {:else if (status?.error || phase === "error") && !busy && !statusFailed}
        <Alert title={phase === "idle" ? "Could not complete the trial" : "Migration needs attention"} tone="error">
          {#if phase === "idle"}
            Check the SSH host and server setup before running the trial again.
          {:else if finalReview && status?.canRecover}
            Check that the server is reachable, then refresh the review.
          {:else if status?.canRecover}
            Check that the server is reachable, then recover the migration.
          {:else if status?.canAbort}
            Review this step or cancel the migration to return to the local gateway.
          {:else}
            Check the server and migration setup before changing either gateway.
          {/if}
        </Alert>
        {#if status?.error}
          <Disclosure>
            {#snippet summary()}Show details{/snippet}
            <div class="grid gap-2 pt-2 pl-6 wrap-anywhere text-muted">
              <p>{status.error}</p>
              <div><CopyButton text={status.error} /></div>
            </div>
          </Disclosure>
        {/if}
      {/if}

      {#if progressText}
        <p class="flex items-center gap-3 text-muted" role="status"><Spinner />{progressText}</p>
      {/if}

      {#if phase === "prepared" || status?.canAbort || status?.canRecover || statusFailed}
        <div class="flex flex-wrap gap-2 border-t border-divider pt-4">
          {#if canStage}
            <Button variant="primary" disabled={!canAct} onclick={stage}>{stageVerb}</Button>
          {/if}
          {#if statusFailed}<Button onclick={() => void refresh()}>Check status</Button>{/if}
          {#if status?.canRecover}
            <Button variant={phase === "error" ? "primary" : "secondary"} disabled={!canAct} onclick={recover}
              >{finalReview ? "Refresh review" : "Recover migration"}</Button
            >
          {/if}
          {#if status?.canAbort}
            <Button variant="ghost" disabled={!canAct} onclick={abort}>Cancel migration</Button>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</main>

<Toaster />
