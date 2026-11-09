import { PersistentArchivedCache } from "./archived-cache";
import { prepareSnapshotStorage } from "./thread-cache-native";

export async function prepareArchivedCache(session: { deviceId: string; fingerprint: string } | null) {
  const storage = await prepareSnapshotStorage("archived-threads-v1", session);

  if (!storage) return null;
  const cache = new PersistentArchivedCache(storage);
  await cache.restore();

  return cache;
}
