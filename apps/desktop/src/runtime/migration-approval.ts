import type { DesktopMigrationApproval } from "@canopy/ui/desktop";
import type { MigrationJournal } from "./migration-state.ts";
import { MigrationSourceError } from "./migration-source.ts";

export function requireApproval(operation: MigrationJournal, approval: DesktopMigrationApproval) {
  const review = operation.preparation?.review;

  if (
    !review ||
    review.archiveSha256 !== operation.archiveSha256 ||
    review.reviewDigest !== approval.reviewDigest ||
    review.blockers.length ||
    Object.keys(approval.conflictChoices).length !== review.conflicts.length ||
    review.conflicts.some((conflict) => !Object.hasOwn(approval.conflictChoices, conflict.id))
  )
    throw new MigrationSourceError("Review the final archive and resolve its conflicts before confirming the join.");

  const required = review.secrets.filter((secret) => {
    const conflict = review.conflicts.find(
      (value) => value.table === secret.table && value.sourceKey === secret.sourceKey,
    );

    return !conflict || approval.conflictChoices[conflict.id] === "source";
  });

  const approved = new Set(approval.approvedSecretIds);

  if (
    approved.size !== approval.approvedSecretIds.length ||
    approved.size !== required.length ||
    required.some((secret) => !approved.has(secret.id))
  )
    throw new MigrationSourceError(
      "Confirm every secret required by the selected source configuration before joining.",
    );

  return approval;
}
