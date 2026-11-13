import { useEffect, useMemo } from "react";
import { File, Paths } from "expo-file-system";
import { Code, ConnectError } from "@connectrpc/connect";
import { WorkspaceStore } from "@canopy/domain/workspace";
import { WorkspaceFileConflict } from "@canopy/domain/workspace-file";
import type { routedMobileClient } from "../../api/routes";
import type { DeviceSession } from "../../storage/session";

const metadataFile = (scope: string) =>
  new File(Paths.document, `canopy.workspace.v1.${encodeURIComponent(scope)}.json`);

/** Pairing-scoped metadata. Contents and drafts never enter the filesystem or transcript cache. */
export function useWorkspaceStore(client: ReturnType<typeof routedMobileClient> | null, session: DeviceSession | null) {
  const scope = session ? `${session.fingerprint}.${session.deviceId}` : "unpaired";

  const store = useMemo(
    () =>
      new WorkspaceStore(
        {
          async watchFiles(request, signal, receive) {
            if (!client) return;

            for await (const update of client.api.watchThreadFiles(request, { signal, timeoutMs: 0 })) receive(update);
          },
          async listDirectory(request, signal) {
            if (!client) throw new Error("This phone is not paired. Pair it, then reopen Files.");

            try {
              return await client.api.listThreadDirectory(request, { signal, timeoutMs: 12_000 });
            } catch (cause) {
              const error = ConnectError.from(cause);
              throw new Error(
                error.code === Code.Unimplemented ? "Update Canopy on your gateway to browse files." : error.rawMessage,
              );
            }
          },
          async read(target, path, hash, signal) {
            if (!client) throw new Error("This phone is not paired. Pair it, then reopen the file.");

            return client.api.readThreadFile(
              { threadId: target.threadId, itemId: target.itemId ?? "", path, expectedSha256: hash },
              { signal, timeoutMs: 40_000 },
            );
          },
          async write(target, path, text, hash, root) {
            if (!client) throw new Error("This phone is not paired. Pair it, then reopen the file.");

            return fileMutation(() =>
              client.api.writeThreadFile(
                {
                  threadId: target.threadId,
                  path,
                  content: new TextEncoder().encode(text),
                  expectedSha256: hash,
                  expectedRootIdentity: root ?? "",
                },
                { timeoutMs: 40_000 },
              ),
            );
          },
          async remove(target, path, hash, root) {
            if (!client) throw new Error("This phone is not paired. Pair it, then reopen the file.");
            await fileMutation(() =>
              client.api.deleteThreadFile(
                { threadId: target.threadId, path, expectedSha256: hash, expectedRootIdentity: root ?? "" },
                { timeoutMs: 40_000 },
              ),
            );
          },
        },
        8 * 1024 * 1024,
      ),
    [client],
  );

  useEffect(() => {
    if (!client) return;
    const file = metadataFile(scope);

    try {
      store.connect(file.exists ? file.textSync() : null, (raw) => {
        try {
          if (!file.exists) file.create();
          file.write(raw);
        } catch {
          for (const view of store.views.values())
            view.error = "Tab state could not be saved. Check device storage, then retry.";
        }
      });
    } catch {
      store.connect(null, () => {});
    }

    return () => store.clear();
  }, [client, store, scope]);

  return store;
}

async function fileMutation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const error = ConnectError.from(cause);

    if (error.code === Code.Aborted) throw new WorkspaceFileConflict(error.rawMessage);
    throw cause;
  }
}

export function forgetWorkspace(session: DeviceSession | null): void {
  const scope = session ? `${session.fingerprint}.${session.deviceId}` : "unpaired";
  const file = metadataFile(scope);

  if (file.exists) file.delete();
}
