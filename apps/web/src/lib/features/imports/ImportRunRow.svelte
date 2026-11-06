<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { formatRelative } from "#lib/shared/format.ts";
  import type { Tone } from "#lib/shared/ui/tone.ts";
  import type { ImportRunsState } from "./import-runs.svelte.ts";
  import { agentCliName, counted, size } from "./labels.ts";

  /** One import run: progress, counts, actions and, when opened, its threads (docs/import.md, "Przebieg"). */
  let { run, runs }: { run: ui.ImportRun; runs: ImportRunsState } = $props();

  const looks = new Map<string, { label: string; tone: Tone }>([
    ["running", { label: "Importing", tone: "sky" }],
    ["paused", { label: "Paused", tone: "amber" }],
    ["completed", { label: "Done", tone: "emerald" }],
    ["failed", { label: "Failed", tone: "rose" }],
    ["cancelled", { label: "Cancelled", tone: "neutral" }],
    ["undone", { label: "Removed", tone: "neutral" }],
  ]);

  const itemLabels = new Map([
    ["pending", "Waiting"],
    ["importing", "Importing"],
    ["done", "Imported"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["undone", "Removed"],
  ]);

  const look = $derived(looks.get(run.status) ?? { label: run.status, tone: "neutral" as const });
  const open = $derived(runs.details.get(run.id));
  const percent = $derived(run.bytesTotal > 0n ? (Number(run.bytesDone) / Number(run.bytesTotal)) * 100 : 0);
  const busy = (action: string) => runs.busy === `${run.id}:${action}`;
  const active = $derived(run.status === "running" || run.status === "paused");
  let confirm = $state(false);
</script>

<li class="flex flex-col gap-2 px-4 py-3">
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <p class="min-w-0 flex-1 font-medium text-zinc-950 dark:text-white">
      <TruncatedText text={`${run.workerName} · ${counted(run.total, "thread")}`} />
    </p>
    <Badge compact tone={look.tone}>{look.label}</Badge>
  </div>
  {#if active}
    <ProgressBar value={percent} label="Import progress" />
  {/if}
  <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
    {[
      formatRelative(run.createdAt),
      `${run.done} imported`,
      run.failed > 0 && `${run.failed} failed`,
      run.cancelled > 0 && `${run.cancelled} cancelled`,
      run.alreadyImported > 0 && `${run.alreadyImported} imported before`,
      `${size(run.bytesDone)} of ${size(run.bytesTotal)}`,
    ]
      .filter(Boolean)
      .join(" · ")}
  </p>
  {#if run.status === "running" && run.current}
    <p class="text-sm text-zinc-600 sm:text-xs dark:text-zinc-300"><TruncatedText text={`Now: ${run.current}`} /></p>
  {/if}
  {#if run.error}<p class="text-sm text-amber-700 sm:text-xs dark:text-amber-400">{run.error}</p>{/if}
  <div class="flex flex-wrap gap-2">
    {#if active}
      <Button size="sm" loading={busy("cancel")} onclick={() => runs.act(run.id, "cancel")}>Cancel</Button>
    {/if}
    {#if run.status === "paused" || run.failed > 0}
      <Button size="sm" icon="arrow-path" loading={busy("resume")} onclick={() => runs.act(run.id, "resume")}>
        {run.status === "paused" ? "Resume" : "Retry failed"}
      </Button>
    {/if}
    {#if run.status !== "undone" && run.done > 0}
      <Button size="sm" variant="ghost" onclick={() => (confirm = true)}>Remove imported threads</Button>
    {/if}
    <Button size="sm" variant="ghost" onclick={() => (open ? runs.close(run.id) : void runs.open(run.id))}>
      {open ? "Hide threads" : "Show threads"}
    </Button>
  </div>
  {#if open}
    <ul
      role="list"
      class="divide-y divide-zinc-950/5 rounded-lg ring-1 ring-zinc-950/5 dark:divide-white/5 dark:ring-white/5"
    >
      {#each open.items as item (item.id)}
        <li class="flex flex-col gap-0.5 px-3 py-2 text-base/6 sm:text-sm/6">
          <div class="flex min-w-0 items-center gap-2">
            {#if item.threadId && item.status === "done"}
              <a class="min-w-0 flex-1 text-zinc-950 hover:underline dark:text-white" href="/threads/{item.threadId}">
                <TruncatedText text={item.title || "Untitled thread"} />
              </a>
            {:else}
              <span class="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">
                <TruncatedText text={item.title || "Untitled thread"} />
              </span>
            {/if}
            <span class="shrink-0 text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
              {agentCliName(item.agentCli)} · {itemLabels.get(item.status) ?? item.status}
            </span>
          </div>
          {#if item.error}<p class="text-sm text-rose-700 sm:text-xs dark:text-rose-400">{item.error}</p>{/if}
          {#each item.warnings as warning (warning)}
            <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">{warning}</p>
          {/each}
        </li>
      {/each}
    </ul>
  {/if}
</li>

<Dialog bind:open={confirm} title="Remove imported threads?" dismissible={!busy("undo")}>
  <div class="grid gap-4">
    <p class="text-base text-zinc-600 sm:text-sm dark:text-zinc-300">
      Canopy deletes the {counted(run.done, "thread")} this import created. The CLI files stay as they are, so you can import
      them again.
    </p>
    {#if runs.error}<Alert tone="error">{runs.error}</Alert>{/if}
    <DialogActions>
      <Button disabled={busy("undo")} onclick={() => (confirm = false)}>Cancel</Button>
      <Button
        variant="danger"
        loading={busy("undo")}
        onclick={async () => {
          await runs.act(run.id, "undo");
          confirm = false;
        }}>Remove threads</Button
      >
    </DialogActions>
  </div>
</Dialog>
