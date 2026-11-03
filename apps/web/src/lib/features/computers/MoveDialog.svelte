<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import { goto } from "$app/navigation";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { computerName } from "./computers.ts";
  import { finished, getMoves, movedProjects, moveTargets, previewMove, startMove, targetWorkspaces, type MoveRef } from "./moves.ts";
  import MovePreview from "./MovePreview.svelte";
  import MoveProgress from "./MoveProgress.svelte";

  /**
   * "Move to…" (docs/linked-computers.md, stage 8): choose a linked computer (and a workspace there for
   * threads), see what moves and what has to be done again, then follow the move to its result.
   * `everything`: every thread and bot of this computer, to the fixed `nodeId` (laptop replacement).
   */
  let { open = $bindable(false), items = [], everything = false, nodeId, name = "", class: className }: {
    open?: boolean; items?: MoveRef[]; everything?: boolean; nodeId?: string; name?: string; class?: ClassValue;
  } = $props();
  const overview = useOverview();
  const targets = $derived(moveTargets(overview.computers.values()));
  let target = $state<string>();
  let preview = $state.raw<ui.MovePreview>();
  let loading = $state(false);
  let error = $state("");
  let placements = $state<Record<string, string | undefined>>({});
  let moves = $state.raw<ui.ComputerMove[]>([]);
  let starting = $state(false);
  const targetName = $derived(computerName(target ? overview.computer(target) : undefined));
  const projects = $derived(movedProjects(preview));
  const movable = $derived(preview?.items.filter((i) => !i.blocked) ?? []);
  const ready = $derived(Boolean(preview && !preview.unavailable && movable.length && projects.every((p) => placements[p.id])));
  const running = $derived(moves.length > 0 && !moves.every(finished));
  const moved = $derived(moves.filter((m) => m.state === "done" || m.state === "committed"));
  const title = $derived(everything ? `Move everything to ${targetName}` : `Move “${name}” to…`);

  // A fresh start each time the dialog opens: the default target is the given or first ready computer.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      target = nodeId ?? targets.find((t) => !t.disabled)?.value;
      preview = undefined; moves = []; error = ""; placements = {};
    });
  });
  // The preview follows the chosen computer; its workspaces default to the same project there.
  $effect(() => {
    const chosen = target;
    if (!open || !chosen || moves.length) return;
    let current = true;
    loading = true; error = "";
    previewMove({ nodeId: chosen, ...(everything ? { everything: true } : { items }) })
      .then((result) => {
        if (!current) return;
        preview = result;
        const next: Record<string, string | undefined> = {};
        for (const project of movedProjects(result)) next[project.id] = targetWorkspaces(overview.projects, chosen, project)[0]?.value;
        placements = next;
      })
      .catch((cause) => { if (current) { preview = undefined; error = cause instanceof Error ? cause.message : "Could not prepare the move"; } })
      .finally(() => { if (current) loading = false; });
    return () => { current = false; };
  });
  // While moves run, follow them; they keep running when the dialog closes.
  $effect(() => {
    if (!open || !running) return;
    const batch = moves[0]?.batchId ?? "";
    const ids = new Set(moves.map((m) => m.id));
    const timer = setInterval(() => {
      void getMoves(batch).then((list) => { moves = list.moves.filter((m) => ids.has(m.id)); }).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  });

  async function move() {
    if (!target || !preview) return;
    starting = true; error = "";
    try {
      const result = await startMove({ nodeId: target, ...(everything ? { everything: true } : { items: movable.map((i) => ({ kind: i.kind as MoveRef["kind"], id: i.id })) }),
        placements: projects.map((p) => ({ projectId: p.id, workspaceId: placements[p.id]! })) });
      moves = result.moves;
    } catch (cause) { error = cause instanceof Error ? cause.message : "Could not start the move"; }
    finally { starting = false; }
  }
  function openMoved() {
    const done = moved[0];
    if (!done?.newId) return;
    open = false;
    void goto(done.kind === "bot" ? `/bots/${done.newId}` : `/threads/${done.newId}`);
  }
</script>

<Dialog bind:open class={className} size="lg" {title}
  description={moves.length ? undefined : `${everything ? "Every thread and bot of this computer" : "It"} gets a new home on the other computer. Old links keep working and lead there.`}>
  <div class="grid min-w-0 grid-cols-1 gap-5">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if moves.length}
      <MoveProgress {moves} target={targetName} />
      <DialogActions>
        <Button onclick={() => (open = false)}>Close</Button>
        {#if !running && !everything && moved.length === 1}<Button variant="primary" onclick={openMoved}>Open on {targetName}</Button>{/if}
      </DialogActions>
    {:else}
      {#if !nodeId}
        <Field label="Move to" description={targets.length ? undefined : "Link another computer in Settings → Linked computers first."}>
          <Select name="move-target" bind:value={target} options={targets} placeholder="Choose a computer…" disabled={!targets.length} />
        </Field>
      {/if}
      {#if loading}
        <div class="grid gap-2" aria-hidden="true"><Skeleton class="h-5 w-2/3" /><Skeleton class="h-5 w-1/2" /></div>
      {:else if preview && target}
        <MovePreview {preview} {target} {targetName} {everything} bind:placements />
      {/if}
      <DialogActions>
        <Button onclick={() => (open = false)}>Cancel</Button>
        <Button variant="primary" icon="arrows-right-left" disabled={!ready || loading} loading={starting} onclick={() => void move()}>
          {everything && movable.length ? `Move ${movable.length} ${movable.length === 1 ? "item" : "items"}` : "Move"}
        </Button>
      </DialogActions>
    {/if}
  </div>
</Dialog>
