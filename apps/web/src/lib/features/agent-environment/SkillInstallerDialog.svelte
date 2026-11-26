<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import type { SkillArtifact, ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import SkillInstallerTerminal from "./SkillInstallerTerminal.svelte";
  import { SkillInstallerSession } from "./skill-installer-session.svelte.ts";

  let {
    open = $bindable(false),
    command = $bindable(""),
    workers,
    oncollect,
    onupload,
    onexisting,
  }: {
    open?: boolean;
    command?: string;
    workers: readonly ui.EnvironmentWorker[];
    oncollect: (artifact: SkillArtifact, worker: ui.EnvironmentWorker, path: string) => void;
    onupload: () => void;
    onexisting: (workerId?: string) => void;
  } = $props();

  let workerId = $state("");
  let skillPath = $state("");
  let session = $state.raw<SkillInstallerSession>();
  let computer = $state.raw<ui.EnvironmentWorker>();
  let terminalRegion = $state<HTMLDivElement>();
  let resultView = $state<HTMLDivElement>();
  let actions = $state<HTMLDivElement>();
  let commandInput = $state<HTMLTextAreaElement>();
  let wasOpen = false;
  const formId = $props.id();
  const available = $derived(workers.filter((worker) => worker.online && worker.skillInstallerSupported));
  const selectedWorker = $derived(available.find((worker) => worker.workerId === workerId) ?? available[0]);
  const selectedPath = $derived(session?.paths.length === 1 ? session.paths[0] : skillPath);

  const status = $derived(
    session?.phase === "starting"
      ? "Starting…"
      : session?.phase === "stopping"
        ? "Stopping…"
        : session?.active
          ? "Running"
          : session?.stopped
            ? "Stopped"
            : session?.succeeded
              ? "Finished"
              : "Failed",
  );

  $effect(() => {
    if (open && !wasOpen) untrack(edit);

    if (!open) untrack(() => session?.dispose());
    wasOpen = open;
  });

  $effect(() => {
    if (!resultView || !terminalRegion?.contains(document.activeElement)) return;
    resultView.scrollIntoView({ block: "nearest", behavior: "instant" });
    const target = resultView.querySelector("button") ?? actions?.querySelector("[data-review]");

    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  });

  onDestroy(() => session?.dispose());

  function reset() {
    session?.dispose();
    session = undefined;
    computer = undefined;
    skillPath = "";
  }

  function edit() {
    reset();
    void tick().then(() => commandInput?.focus());
  }

  function run(event: SubmitEvent) {
    event.preventDefault();
    const worker = selectedWorker;

    if (!worker || !command.trim() || session) return;
    workerId = worker.workerId;
    computer = worker;
    session = new SkillInstallerSession(worker.workerId);
  }

  function close(next: () => void) {
    session?.dispose();
    open = false;
    next();
  }

  async function collect() {
    const current = session;
    const worker = computer;
    const path = selectedPath;

    if (!worker || !path) return;
    const artifact = await current?.collect(path);

    if (!artifact || !open || current !== session) return;
    close(() => oncollect(artifact, worker, path));
  }
</script>

<Dialog bind:open title="Run skill installer" size="lg" stickyHeader fullscreen>
  {#if session && computer}
    <div class="grid min-w-0 gap-4">
      <div bind:this={terminalRegion} class="min-w-0">
        <SkillInstallerTerminal {session} {command}>
          {#snippet header(selection)}
            <div class="flex min-w-0 items-start gap-2">
              <div class="grid min-w-0 flex-1 gap-1">
                <p class="truncate font-mono text-base sm:text-sm" title={command}>{command}</p>
                <div class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-sm text-muted">
                  <span class="min-w-0 wrap-anywhere">{computer?.name || computer?.workerId}</span>
                  <span role="status">{status}</span>
                </div>
              </div>
              <div class:invisible={!selection}>
                <CopyButton text={selection} label="Copy terminal selection" />
              </div>
            </div>
          {/snippet}
        </SkillInstallerTerminal>
      </div>

      {#if session.error}
        <Alert tone="error">{session.error}</Alert>
      {:else if !session.active && !session.stopped && !session.succeeded && session.exitCode}
        <Alert tone="error">The installer exited with code {session.exitCode}. Check the output and run it again.</Alert
        >
      {/if}
      {#if session.succeeded}
        {#if session.paths.length}
          <div bind:this={resultView} class="min-w-0 scroll-mt-20 scroll-mb-20 border-t border-divider pt-3">
            {#if session.paths.length === 1}
              <p class="text-sm font-medium">Skill folder</p>
              <p class="mt-1 font-mono text-sm wrap-anywhere text-muted select-text">{selectedPath}</p>
            {:else}
              <Field label="Skill folder">
                <Select
                  name="skill-installer-path"
                  value={selectedPath}
                  placeholder="Choose a folder"
                  options={session.paths.map((path) => ({ value: path, label: path }))}
                  onchange={(value) => (skillPath = value)}
                  disabled={session.collecting}
                />
              </Field>
            {/if}
          </div>
        {:else}
          <p class="text-base text-muted sm:text-sm">Canopy couldn’t locate the skill. Check the computer for it.</p>
        {/if}
      {/if}
    </div>
  {:else}
    <form id={formId} class="grid min-w-0 gap-4" onsubmit={run}>
      <Field label="Installer command" description="This command runs with your access on the selected computer.">
        <Textarea
          name="skill-installer-command"
          bind:value={command}
          bind:element={commandInput}
          data-autofocus
          class="w-full font-mono"
          placeholder="Paste the publisher’s command"
          rows={2}
          maxlength={4096}
          resize={false}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
        />
      </Field>
      {#if available.length}
        <Field label="Computer">
          <Select
            name="skill-installer-computer"
            value={selectedWorker?.workerId}
            options={workers.map((worker) => ({
              value: worker.workerId,
              label: worker.name || worker.workerId,
              ...(worker.online && worker.skillInstallerSupported
                ? {}
                : { disabled: true, description: worker.online ? "Installer unavailable" : "Offline" }),
            }))}
            onchange={(value) => (workerId = value)}
          />
        </Field>
      {:else}
        <p class="text-base text-muted sm:text-sm">Connect a computer with installer support to run this command.</p>
      {/if}
    </form>
  {/if}

  {#snippet footer()}
    <div bind:this={actions} class="flex min-w-0 flex-wrap items-center justify-between gap-2">
      {#if !session}
        <Button variant="text" onclick={() => close(onupload)}>Upload a folder or ZIP</Button>
        <Button type="submit" form={formId} variant="primary" disabled={!selectedWorker || !command.trim()}>
          Run installer
        </Button>
      {:else if session.active}
        <div class="ml-auto">
          <Button
            disabled={session.phase !== "starting" && session.phase !== "running"}
            onclick={() => session?.stop()}
          >
            Stop installer
          </Button>
        </div>
      {:else}
        <Button variant="text" disabled={session.collecting} onclick={edit}>Edit command</Button>
        {#if session.paths.length}
          <Button data-review variant="primary" loading={session.collecting} disabled={!selectedPath} onclick={collect}>
            Review files
          </Button>
        {:else}
          <Button onclick={() => close(() => onexisting(workerId))}>Find installed skills</Button>
        {/if}
      {/if}
    </div>
  {/snippet}
</Dialog>
