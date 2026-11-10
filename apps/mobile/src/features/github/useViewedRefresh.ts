import { useCallback, useRef } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSession } from "../../state/session";

/** Viewed may change on another device while the PR's own revision stays unchanged. */
export function useViewedRefresh(refresh: () => Promise<void>) {
  const { online } = useSession();
  const latest = useRef(refresh);
  latest.current = refresh;
  useFocusEffect(
    useCallback(() => {
      const read = () => {
        if (online && AppState.currentState === "active") void latest.current();
      };

      read();
      const timer = setInterval(read, 60_000);

      const listener = AppState.addEventListener("change", (state) => {
        if (state === "active") read();
      });

      return () => {
        clearInterval(timer);
        listener.remove();
      };
    }, [online]),
  );
}
