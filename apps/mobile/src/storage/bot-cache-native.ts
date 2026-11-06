import { prepareSnapshotStorage } from "./thread-cache-native";
import { PersistentBotCache } from "./bot-cache";

export async function prepareBotCache(session: { deviceId: string; fingerprint: string } | null) {
  const storage = await prepareSnapshotStorage("bot-snapshots-v1", session);

  return storage ? new PersistentBotCache(storage) : null;
}
