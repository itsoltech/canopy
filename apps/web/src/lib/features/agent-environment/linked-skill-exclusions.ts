import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { environmentSelected } from "@canopy/domain/environment-selectors";
import { splitId } from "@canopy/domain/computers";
import { requestJson } from "#lib/shared/http.ts";
import { sharedRead } from "#lib/shared/queries.svelte.ts";
import { decode, encode } from "#lib/shared/wire.ts";

const path = (id: string) => `/api/workers/${encodeURIComponent(id)}/environment`;

const read = async (id: string, signal: AbortSignal) =>
  decode(ui.WorkerEnvironmentResponseSchema, await requestJson("GET", path(id), undefined, undefined, signal));

export function linkedSkillCandidates(records: readonly ui.WorkerRecord[], skill: ui.LibrarySkill) {
  return records.filter((record) => {
    const worker = create(ui.EnvironmentWorkerSchema, {
      workerId: splitId(record.workerId).id,
      automaticTags: record.automaticTags,
      manualTags: record.manualTags,
    });

    return !record.revoked && environmentSelected(skill.selector, worker);
  });
}

export type LinkedExclusion = { item: string; versionHash: string; revision: bigint };

export type Eligibility = { assignment: LinkedExclusion } | { reason: string };

export async function sharedSkillItem(localWorker: string, skillId: string, signal: AbortSignal) {
  if (!localWorker) return;
  const response = await read(localWorker, signal);

  if (response.worker?.workerId !== localWorker) return;

  return response.items.find((entry) => entry.kind === "skill" && entry.localId === skillId)?.item;
}

export async function linkedEligibility(workerId: string, item: string, signal: AbortSignal): Promise<Eligibility> {
  const response = await read(workerId, signal);
  const entry = response.items.find((i) => i.kind === "skill" && i.item === item);

  if (!entry?.localId || response.worker?.workerId !== workerId)
    return { reason: "Check the shared skill on this computer." };
  const override = response.overrides.find((o) => o.kind === "skill" && o.item === item);

  if (override?.disabled) return { reason: "Already excluded from sync." };

  if (!response.worker.skillIds.includes(entry.localId)) return { reason: "This skill is not assigned here." };

  return { assignment: { item, revision: response.revision, versionHash: override?.versionHash ?? "" } };
}

export async function excludeLinkedWorker(workerId: string, assignment: LinkedExclusion, revision: bigint) {
  const request = create(ui.SetWorkerEnvironmentOverrideRequestSchema, {
    workerId,
    expectedRevision: revision,
    override: { kind: "skill", item: assignment.item, disabled: true, versionHash: assignment.versionHash },
  });

  const saved = decode(
    ui.WorkerEnvironmentResponseSchema,
    await requestJson("PUT", path(workerId), encode(ui.SetWorkerEnvironmentOverrideRequestSchema, request)),
  );

  const cache = sharedRead(`GetWorkerEnvironment:${workerId}`, ui.WorkerEnvironmentResponseSchema, path(workerId));

  if (!cache.data || cache.data.revision <= saved.revision) cache.set(saved);

  if (
    saved.worker?.workerId !== workerId ||
    !saved.overrides.some(
      (o) => o.kind === "skill" && o.item === assignment.item && o.disabled && o.versionHash === assignment.versionHash,
    )
  )
    throw new Error("Check the saved assignment on this computer.");

  return saved.revision;
}
