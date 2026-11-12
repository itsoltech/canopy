import { useCallback } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSession } from "../../state/session";
import type { github } from "@canopy/contracts";
import { invalidations } from "./invalidations";

export function usePullRequestWatch(id: string, changed: (update: github.PullRequestUpdate) => void) {
  const { client, queries } = useSession();
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      let controller: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const key = `PullRequestWatch:${id}`;
      let revision = queries.snapshot<string>(key).data ?? "";

      async function watch() {
        if (stopped || AppState.currentState !== "active") return;
        controller?.abort();
        controller = new AbortController();

        try {
          for await (const update of client!.api.watchPullRequest(
            { pullRequestId: id, visibility: "view", revision },
            { signal: controller.signal, timeoutMs: 0 },
          )) {
            if (update.gap) invalidations.publish(id);
            else if (!revision || revision !== update.revision)
              for (const resource of update.invalidated) invalidations.publish(`${id}:${resource}`);
            revision = update.revision;
            queries.set(key, revision);
            changed(update);
          }
        } catch {
          /* The existing query retains the last verified snapshot while the home is offline. */
        }

        if (!stopped && AppState.currentState === "active") timer = setTimeout(() => void watch(), 2000);
      }

      const listener = AppState.addEventListener("change", (state) => {
        clearTimeout(timer);
        controller?.abort();

        if (state === "active") void watch();
      });

      void watch();

      return () => {
        stopped = true;
        clearTimeout(timer);
        controller?.abort();
        listener.remove();
      };
    }, [client, queries, id, changed]),
  );
}
