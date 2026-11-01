<script lang="ts">
  /** Status pill for threads, turns and workers; colour carries meaning, the text is always shown. */
  let { status }: { status: string } = $props();

  const tone = $derived(
    {
      running: "bg-sky-100 text-sky-800",
      creating: "bg-sky-100 text-sky-800",
      queued: "bg-slate-100 text-slate-700",
      idle: "bg-emerald-100 text-emerald-800",
      completed: "bg-emerald-100 text-emerald-800",
      online: "bg-emerald-100 text-emerald-800",
      waiting_input: "bg-amber-100 text-amber-900",
      pending: "bg-amber-100 text-amber-900",
      interrupted: "bg-orange-100 text-orange-900",
      failed: "bg-rose-100 text-rose-800",
      offline: "bg-slate-200 text-slate-600",
    }[status] ?? "bg-slate-100 text-slate-700",
  );
</script>

<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {tone}">{status.replace("_", " ")}</span>
