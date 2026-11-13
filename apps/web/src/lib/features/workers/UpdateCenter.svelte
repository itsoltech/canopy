<script lang="ts">
  import { Provider } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import WorkerUpdateRow from "./WorkerUpdateRow.svelte";
  import CliToolRow from "./CliToolRow.svelte";
  import UpdateNotes from "./UpdateNotes.svelte";
  import UpdateRun from "./UpdateRun.svelte";
  import UpdateActionButton from "./UpdateActionButton.svelte";
  import { cliActions } from "./cli-tools.svelte.ts";
  import { updateBusy, updateStateLabel, type UpdatesState } from "./updates.svelte.ts";

  let { updates, class: className }: { updates: UpdatesState; class?: ClassValue } = $props();

  const snapshot = $derived(updates.snapshot);
  const cli = cliActions();
  const running = $derived(snapshot?.run?.state === "running");
  const busy = $derived(running || !!updates.pending);
  const gatewayStep = $derived(snapshot?.run?.steps.find((s) => s.kind === "gateway"));

  async function check() {
    if (snapshot?.admin) await updates.manage({ action: "check" });
    await cli.check();
    await updates.reload();
  }
</script>

<section class={["grid gap-4", className]} aria-label="Gateway and worker updates">
  <div class="flex flex-wrap gap-2">
    <UpdateActionButton {updates} />
    <Button
      size="sm"
      disabled={busy || cli.pending["check/"]}
      loading={updates.pending === "check" || snapshot?.checking || cli.pending["check/"]}
      onclick={() => void check()}>Check for updates</Button
    >
  </div>
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Gateway first, then binary workers, agent CLIs, and Canopy apps. Linked computers restart one at a time; this
    computer restarts last. Independent updates continue after a failure.
  </p>
  {#if updates.error}<Alert tone="error">{updates.error}</Alert>{/if}
  {#if snapshot?.checkError}<Alert tone="error">{snapshot.checkError}</Alert>{/if}
  {#if cli.errors["check/"]}<Alert tone="error">{cli.errors["check/"]}</Alert>{/if}
  {#if snapshot}
    {#if snapshot.run}<UpdateRun run={snapshot.run} {updates} />{/if}
    <section class="grid gap-3 border-t border-zinc-950/5 pt-4 dark:border-white/10" aria-label="Gateway update">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-base font-medium tabular-nums sm:text-sm">Gateway · {snapshot.gatewayVersion}</h3>
        <Badge tone={snapshot.gatewayState === "failed" ? "rose" : "neutral"}
          >{snapshot.checking
            ? "Checking"
            : updateBusy(snapshot.gatewayState)
              ? updateStateLabel(snapshot.gatewayState, true)
              : snapshot.gatewayInstallKind === "binary"
                ? "Binary install"
                : snapshot.gatewayInstallKind === "desktop"
                  ? "Bundled with this app"
                  : "Managed externally"}</Badge
        >
      </div>
      <p class="text-base/6 text-zinc-500 tabular-nums sm:text-sm/6 dark:text-zinc-400">
        {snapshot.gatewayUpdateAvailable
          ? `Available: ${snapshot.availableVersion} · ${snapshot.channel}`
          : snapshot.checkError || !snapshot.availableVersion
            ? "Release availability could not be confirmed"
            : `No newer gateway release · ${snapshot.channel}`}
      </p>
      {#if snapshot.gatewayReason}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          {snapshot.gatewayReason}
        </p>{/if}
      {#if snapshot.gatewayInstallKind === "binary" && snapshot.gatewayUpdateAvailable}<div>
          <Button
            size="sm"
            disabled={busy || !snapshot.admin || updateBusy(snapshot.gatewayState)}
            onclick={() => void updates.manage({ action: "gateway" })}>Update gateway</Button
          >
        </div>{/if}
      {#if updateBusy(snapshot.gatewayState)}<ProgressBar label={updateStateLabel(snapshot.gatewayState, true)} />{/if}
      <UpdateNotes
        current={gatewayStep?.fromVersion || snapshot.gatewayVersion}
        target={gatewayStep?.version || snapshot.availableVersion}
        channel={snapshot.channel}
        expanded={updateBusy(snapshot.gatewayState)}
      />
    </section>
    {#each snapshot.workers as worker (worker.workerId)}
      {@const tools = (snapshot.cliWorkers.find((w) => w.id === worker.workerId)?.cliTools ?? []).filter(
        (item) => !!item.tool,
      )}
      {@const step = snapshot.run?.steps.find(
        (s) => s.workerId === worker.workerId && ["worker", "desktop"].includes(s.kind),
      )}
      <section
        class="grid gap-3 border-t border-zinc-950/5 pt-4 dark:border-white/10"
        aria-label={`${worker.name} updates`}
      >
        <WorkerUpdateRow
          {worker}
          gatewayVersion={snapshot.gatewayVersion}
          admin={snapshot.admin && !running}
          pending={updates.pending}
          disabled={running}
          onupdate={() =>
            void updates.manage({
              action: worker.installKind === "desktop" ? "desktop" : "worker",
              workerId: worker.workerId,
            })}
          onforce={() =>
            void updates.manage({
              action: "desktop",
              workerId: worker.workerId,
              force: true,
              desktopRequestId: worker.desktop?.requestId ?? "",
            })}
        />
        <UpdateNotes
          current={step?.fromVersion || worker.desktop?.version || worker.version}
          target={worker.desktop?.targetVersion ||
            step?.version ||
            worker.desktop?.availableVersion ||
            (worker.state === "ahead" ? "" : snapshot.gatewayVersion)}
          channel={worker.desktop?.channel || snapshot.channel}
          expanded={updateBusy(worker.state) ||
            ["downloading", "waiting_idle", "restarting"].includes(worker.desktop?.phase ?? "")}
        />
        {#if tools.length}
          <Disclosure open={tools.some((t) => t.tool?.install?.state === "running")}>
            {#snippet summary()}<span>Agent CLIs · {tools.filter((t) => !!t.action).length} available</span>{/snippet}
            <div class="grid gap-4 pt-4">
              {#each tools as item (item.tool?.provider)}
                {#if item.tool}<div class="grid gap-3">
                    <CliToolRow workerId={worker.workerId} {item} disabled={busy} />
                    {#if item.tool.provider !== Provider.GROK}<UpdateNotes
                        current={item.tool.install?.previousVersion || item.tool.version}
                        target={item.tool.install?.targetVersion || item.latest?.version || ""}
                        channel="stable"
                        source={item.tool.provider === Provider.CLAUDE ? "claude" : "codex"}
                        expanded={item.tool.install?.state === "running"}
                      />{/if}
                  </div>{/if}
              {/each}
            </div>
          </Disclosure>
        {/if}
      </section>
    {/each}
    <a
      href="/settings/workers"
      class="w-fit text-base/6 text-zinc-500 underline focus-ring sm:text-sm/6 dark:text-zinc-400"
      >Worker settings and update details</a
    >
  {:else}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">
      Loading update status…
    </p>{/if}
</section>
