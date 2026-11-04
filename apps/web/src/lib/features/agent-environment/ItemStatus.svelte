<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { environmentSelected } from "@canopy/domain/environment-selectors";
  import Badge from "#lib/shared/ui/Badge.svelte";

  let {
    workers,
    selector,
    disabled = [],
    kind,
    id,
    harness,
    label = "",
    class: className,
  }: {
    workers: readonly ui.EnvironmentWorker[];
    selector?: ui.EnvironmentSelector;
    disabled?: readonly string[];
    kind: "instructions" | "skills" | "plugins";
    id: string;
    harness?: string;
    label?: string;
    class?: ClassValue;
  } = $props();

  const status = $derived.by(() => {
    if (label) return label;
    const matching = workers.filter((w) => environmentSelected(selector, w) && !disabled.includes(w.workerId));

    if (!matching.length) return "No computers";

    if (
      matching.some((w) =>
        kind === "instructions" ? !w.supported : kind === "skills" ? !w.skillsSupported : !w.pluginsSupported,
      )
    )
      return "Worker update needed";

    const reports = matching.map((w) =>
      kind === "instructions"
        ? (w.report?.files ?? []).filter((f) => f.harness === harness).map((f) => f.status)
        : (w.report?.[kind] ?? []).filter((f) => f.skillId === id).map((f) => f.status),
    );

    if (
      matching.some((w) => w.compositionError) ||
      reports.some((statuses) => statuses.some((status) => ["error", "drift", "kept"].includes(status)))
    )
      return "Needs review";

    if (
      matching.some((w) => !w.online || !w.report || w.report.revision !== w.desiredRevision) ||
      reports.some((statuses) => !statuses.length || statuses.some((status) => status !== "applied"))
    )
      return "Sync pending";

    return "Synced";
  });
</script>

<div class={className}>
  <Badge
    compact
    tone={status === "Synced"
      ? "emerald"
      : status === "Needs review" || status === "Update available"
        ? "amber"
        : "neutral"}>{status}</Badge
  >
</div>
