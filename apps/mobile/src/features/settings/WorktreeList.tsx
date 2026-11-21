import { useLayoutEffect, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import type { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button, Notice } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

export function WorktreeList({
  scope,
  worktreeId,
}: {
  scope: { projectId: string; workerId: string };
  worktreeId?: string;
}) {
  const resource = useSettingsResource(`ListWorktrees:${scope.projectId}:${scope.workerId}`, (api) =>
    api.listWorktrees(scope),
  );

  const [preview, setPreview] = useState<ui.ListWorktreesResponse>();

  const entries = (preview ?? resource.data)?.entries.filter(
    (entry) => !worktreeId || entry.worktree?.id === worktreeId,
  );

  const cleanup = useFailedWorktreeCleanup(resource.data?.entries, resource, () => setPreview(undefined));
  const detachedIssue = cleanup.issue && !entries?.some((entry) => entry.worktree?.id === cleanup.issue?.worktreeId);

  function refresh() {
    setPreview(undefined);
    cleanup.reset();

    return resource.reload();
  }

  const remove = (entry: ui.WorktreeEntry) => {
    const id = entry.worktree?.id;

    if (!id) return;
    confirmAction(
      "Remove worktree",
      entry.confirmationRequired
        ? "This deletes local changes in the reviewed worktree. Thread history stays."
        : "This removes the worktree directory. Thread history stays.",
      () =>
        void resource.run((api) =>
          api.removeWorktree({
            worktreeId: id,
            confirmLocalChanges: entry.confirmationRequired,
            expectedHeadCommit: entry.status?.headCommit ?? "",
          }),
        ),
    );
  };

  return (
    <ResourceState
      resource={{
        ...resource,
        reload: refresh,
        error: (detachedIssue ? cleanup.issue?.message : undefined) || resource.error,
      }}
    >
      <SettingsGroup title="Worktrees">
        <SettingsSkeletonRows controls />
        <Button title="Refresh status" busy={resource.busy} onPress={() => void refresh()} />
        {!worktreeId && (
          <Button
            title="Preview cleanup"
            busy={resource.busy}
            onPress={() =>
              void resource
                .run((api) => api.cleanupWorktrees({ ...scope, dryRun: true }))
                .then((r) => {
                  if (r) setPreview(r);
                })
            }
          />
        )}
        {preview && (
          <>
            <Notice>{preview.entries.filter((e) => e.wouldRemove).length} worktrees qualify for cleanup.</Notice>
            <Button
              variant="danger"
              title="Clean up worktrees"
              disabled={!preview.entries.some((e) => e.wouldRemove)}
              busy={resource.busy}
              onPress={() =>
                confirmAction(
                  "Clean up worktrees?",
                  "Canopy removes worktrees that match the cleanup rules. Archived and deleted thread rules can discard local files. Thread history stays.",
                  () =>
                    void resource
                      .run((api) => api.cleanupWorktrees({ ...scope, dryRun: false }))
                      .then(() => setPreview(undefined)),
                )
              }
            />
          </>
        )}
        {entries?.map((entry) => (
          <WorktreeRow
            key={entry.worktree?.id}
            entry={entry}
            busy={resource.busy}
            cleanupDisabled={resource.loading}
            cleanupError={cleanup.issue?.worktreeId === entry.worktree?.id ? cleanup.issue?.message : undefined}
            oncleanup={cleanup.review}
            onremove={remove}
            onrefresh={() => void refresh()}
          />
        ))}
        {resource.data && !resource.data.entries.length && (
          <SettingsRow title="No worktrees yet" description="Start a thread in a new worktree to add one." />
        )}
      </SettingsGroup>
    </ResourceState>
  );
}

function useFailedWorktreeCleanup(
  entries: ui.WorktreeEntry[] | undefined,
  resource: Pick<ReturnType<typeof useSettingsResource<ui.ListWorktreesResponse>>, "busy" | "loading" | "run">,
  onconfirmed: () => void,
) {
  const focused = useIsFocused();
  const [issue, setIssue] = useState<{ worktreeId: string; message: string }>();

  const executeCleanup = useRef<(id: string, token: string) => void>(undefined);

  useLayoutEffect(() => {
    executeCleanup.current = focused
      ? (worktreeId, expectedCleanupToken) => {
          const current = entries?.find((entry) => entry.worktree?.id === worktreeId);

          if (
            resource.loading ||
            resource.busy ||
            !current?.worktree?.external ||
            !current.worktree.locked ||
            current.failedCleanupToken !== expectedCleanupToken ||
            !current.online ||
            current.busy ||
            current.removed
          ) {
            setIssue({ worktreeId, message: "This worktree is no longer ready for cleanup." });

            return;
          }

          onconfirmed();
          void resource.run(
            (api) => api.cleanUpFailedWorktree({ worktreeId, expectedCleanupToken, confirmed: true }),
            "",
            (cause) => setIssue({ worktreeId, message: cleanupFailureMessage(cause) }),
          );
        }
      : undefined;

    return () => {
      executeCleanup.current = undefined;
    };
  });

  function reviewCleanup(entry: ui.WorktreeEntry) {
    const tree = entry.worktree;
    const token = entry.failedCleanupToken;

    if (!tree || !token) return;
    const { id, path } = tree;

    confirmAction(
      "Clean up worktree",
      `Canopy deletes the folder and removes the worktree from Git. The local branch stays. You can’t undo this.\n\n${path}`,
      () => executeCleanup.current?.(id, token),
    );
  }

  return { review: reviewCleanup, issue, reset: () => setIssue(undefined) };
}

function cleanupFailureMessage(cause: unknown) {
  if (
    cause instanceof ConnectError &&
    [Code.InvalidArgument, Code.FailedPrecondition, Code.PermissionDenied, Code.NotFound, Code.Aborted].includes(
      cause.code,
    ) &&
    cause.rawMessage
  )
    return cause.rawMessage;

  return "Could not clean up the worktree.";
}

function WorktreeRow({
  entry,
  busy,
  cleanupDisabled,
  cleanupError,
  oncleanup,
  onremove,
  onrefresh,
}: {
  entry: ui.WorktreeEntry;
  busy: boolean;
  cleanupDisabled: boolean;
  cleanupError?: string;
  oncleanup: (entry: ui.WorktreeEntry) => void;
  onremove: (entry: ui.WorktreeEntry) => void;
  onrefresh: () => void;
}) {
  const locked = entry.worktree?.external && entry.worktree.locked;
  const failedSetup = locked && Boolean(entry.failedCleanupToken);

  return (
    <SettingsRow
      title={
        entry.worktree?.detachedCommit
          ? `Detached HEAD · ${entry.worktree.detachedCommit}`
          : entry.worktree?.branch || "Worktree"
      }
      description={entry.worktree?.path}
    >
      <SettingsValue
        title="Status"
        value={
          failedSetup
            ? "Locked worktree"
            : entry.worktree?.external
              ? entry.worktree.unavailableReason || (entry.online ? "Available" : "Offline")
              : entry.detail ||
                entry.status?.detail ||
                (entry.removed ? "Removed" : entry.busy ? "Busy" : entry.online ? "Online" : "Offline")
        }
      />
      {entry.worktree?.external && (
        <SettingsValue title="Management" value={failedSetup ? "Canopy setup failed" : "Created outside Canopy"} />
      )}
      {locked && !failedSetup && entry.failedCleanupReason ? <Notice>{entry.failedCleanupReason}</Notice> : null}
      {cleanupError ? (
        <>
          <Notice error>{cleanupError}</Notice>
          <Button title="Refresh status" busy={busy || cleanupDisabled} onPress={onrefresh} />
        </>
      ) : failedSetup ? (
        <Button
          title="Clean up…"
          disabled={cleanupDisabled || busy || !entry.online || entry.busy || entry.removed}
          onPress={() => oncleanup(entry)}
        />
      ) : null}
      {!entry.worktree?.external && (
        <>
          <SettingsValue
            title="Changes"
            value={`${entry.status?.dirtyFiles ?? 0} files · ${entry.status?.ahead ?? 0} ahead · ${entry.status?.behind ?? 0} behind${entry.status?.unpushed ? " · Unpushed commits" : ""}`}
          />
          <Button
            variant="danger"
            title="Remove worktree"
            disabled={busy || !entry.online || entry.busy || entry.removed || !entry.status?.headCommit}
            onPress={() => onremove(entry)}
          />
        </>
      )}
    </SettingsRow>
  );
}
