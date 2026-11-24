import { Code, ConnectError } from "@connectrpc/connect";
import { useSharedQuery } from "../../state/queries";
import { useSession } from "../../state/session";

export const MEMORY_HABITS = "GetMemoryHabits";

/** Navigation, live notices and Memory share the same snapshot and in-flight request. */
export function useMemoryHabits(enabled = true) {
  const { client, active, online } = useSession();

  return useSharedQuery(
    MEMORY_HABITS,
    async (signal) => {
      if (!client) return null;

      try {
        return await client.api.getMemoryHabits({}, { signal });
      } catch (cause) {
        if (ConnectError.from(cause).code === Code.Unimplemented) return null;
        throw cause;
      }
    },
    Boolean(client) && active && online && enabled,
    30_000,
  );
}

export function usePendingHabitReviews() {
  return useMemoryHabits().data?.suggestions.length ?? 0;
}

export const habitSuggestionLabel = (count: number) =>
  `${count.toLocaleString()} habit ${count === 1 ? "suggestion" : "suggestions"}`;
