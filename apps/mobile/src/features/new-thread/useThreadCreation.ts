import { useSyncExternalStore } from "react";
import { useSession } from "../../state/session";

const subscribeIdle = () => () => {};
const snapshotIdle = () => 0;

export function useThreadCreation(id: string, byThread = false) {
  const { threadCreations } = useSession();
  useSyncExternalStore(threadCreations?.subscribe ?? subscribeIdle, threadCreations?.snapshot ?? snapshotIdle);

  return byThread ? threadCreations?.forThread(id) : threadCreations?.get(id);
}
