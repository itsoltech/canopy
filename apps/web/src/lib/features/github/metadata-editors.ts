import type { github } from "@canopy/contracts";
import { GitHubMetadataEditor, type MetadataKind } from "@canopy/domain/github-metadata";
import { mutations, page } from "./api.ts";
import { github as contract } from "@canopy/contracts";
import { mutationDetail, mutationRefused } from "./mutation-errors.ts";

const editors = new Map<string, GitHubMetadataEditor>();

export function metadataEditor(snapshot: github.PullRequestSnapshot, kind: MetadataKind) {
  const key = `${snapshot.accountId}:${snapshot.accessRevision}:${snapshot.summary?.ref?.id}:${kind}`;
  let editor = editors.get(key);

  if (!editor) {
    editor = new GitHubMetadataEditor(
      kind,
      { ...mutations, getPullRequestMetadata: (r) => page("metadata", contract.PullRequestMetadataPageSchema, r) },
      snapshot,
      () => crypto.randomUUID(),
      mutationRefused,
      mutationDetail,
    );
    editors.set(key, editor);

    if (editors.size > 100) editors.delete(editors.keys().next().value ?? "");
  }

  editor.snapshot = snapshot;

  return editor;
}
