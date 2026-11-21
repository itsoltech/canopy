import { createHash } from "node:crypto";
import { DatabaseMigrationError } from "./postgres-tools.ts";

export interface ConsolidationInput {
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  source: { nodeId: string; ownerUserId: string };
  target: { ownerUserId: string; secretsKey: Buffer };
  archiveSha256: string;
  operationId: string;
}

export interface ConsolidationApproval {
  reviewDigest: string;
  conflictChoices: Record<string, "source" | "target">;
  approvedSecretIds: readonly string[];
}

/** Delivered over the private operator connection, after the source owner approves these exact IDs. */
export interface ApprovedConsolidationSecret {
  id: string;
  plaintext: string;
}

export function consolidationSecretId(tableName: string, sourceKey: string, columnName: string) {
  return consolidationDigest(JSON.stringify([tableName, sourceKey, columnName]));
}

export interface ConsolidationBlocker {
  table: string;
  key: string;
  reason: string;
}

export interface ConsolidationConflict {
  id: string;
  table: string;
  sourceKey: string;
  targetKey: string;
}

export interface ConsolidationSecret {
  id: string;
  table: string;
  sourceKey: string;
}

interface ConsolidationContext {
  operationId: string;
  sourceNodeId: string;
  sourceOwnerUserId: string;
  targetOwnerUserId: string;
  archiveSha256: string;
}

export interface ConsolidationReview extends ConsolidationContext {
  reviewDigest: string;
  counts: Record<string, number>;
  conflicts: readonly ConsolidationConflict[];
  secrets: readonly ConsolidationSecret[];
  blockers: readonly ConsolidationBlocker[];
}

export interface ConsolidationReceipt extends ConsolidationContext {
  reviewDigest: string;
  counts: Record<string, number>;
  alreadyApplied: boolean;
}

export const consolidationError = (message: string) => new DatabaseMigrationError(message);

export function consolidationContext(input: ConsolidationInput) {
  return {
    operationId: input.operationId,
    sourceNodeId: input.source.nodeId,
    sourceOwnerUserId: input.source.ownerUserId,
    targetOwnerUserId: input.target.ownerUserId,
    archiveSha256: input.archiveSha256,
  };
}

const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function validateConsolidation(input: ConsolidationInput) {
  if (
    !hex.test(input.source.nodeId) ||
    !hex.test(input.archiveSha256) ||
    ![input.operationId, input.source.ownerUserId, input.target.ownerUserId].every((id) => uuid.test(id)) ||
    input.sourceDatabaseUrl === input.targetDatabaseUrl ||
    input.target.secretsKey.length !== 32
  )
    throw consolidationError(
      "The consolidation needs a valid operation, archive, owner and key on each distinct database.",
    );
}

export function consolidationDigest(canonicalJson: string) {
  return createHash("sha256").update(canonicalJson).digest("hex");
}

// The approval digest lets an interrupted apply be retried even when its original preflight no longer exists.
export function consolidationApprovalDigest(approval: ConsolidationApproval) {
  return consolidationDigest(
    JSON.stringify({
      reviewDigest: approval.reviewDigest,
      conflictChoices: Object.entries(approval.conflictChoices).sort(([left], [right]) => left.localeCompare(right)),
      approvedSecretIds: [...approval.approvedSecretIds].sort(),
    }),
  );
}
