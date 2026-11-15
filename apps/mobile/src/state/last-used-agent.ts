import { useCallback, useEffect, useRef, useState } from "react";
import { equals } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { latestThreadChoices } from "@canopy/domain/new-thread-choices";
import { useSession } from "./session";
import { useOverviewEvents } from "./overview-bus";

/** Keep the archive seed current when its home or selected user turn changes. */
export function useLastUsedAgent() {
  const { client } = useSession();
  const [value, setValue] = useState<ui.Thread>();
  const current = useRef<ui.Thread | undefined>(undefined);
  const generation = useRef(0);

  const receive = useCallback((thread: ui.Thread | undefined) => {
    generation.current++;
    current.current = thread;
    setValue(thread);
  }, []);

  const refresh = useCallback(() => {
    const requested = generation.current;
    void client?.api
      .getOverview({})
      .then((overview) => {
        if (generation.current === requested) receive(overview.lastUsedAgent);
      })
      .catch(() => {});
  }, [client, receive]);

  useEffect(
    () => () => {
      generation.current++;
    },
    [client],
  );

  useOverviewEvents((update: ui.OverviewUpdate) => {
    const change = update.change;
    const seed = current.current;

    if (change.case === "mobileSnapshot") receive(change.value.overview?.lastUsedAgent);

    if (change.case === "computerSnapshot") {
      const { nodeId, overview } = change.value;
      receive(
        latestThreadChoices([
          ...(seed && seed.nodeId !== nodeId ? [seed] : []),
          ...(overview?.lastUsedAgent ? [overview.lastUsedAgent] : []),
        ]),
      );

      if (seed?.nodeId === nodeId) refresh();
    }

    if (change.case === "computerRemoved" && seed?.nodeId === change.value) {
      receive(undefined);
      refresh();
    }

    if (change.case !== "thread" || !seed || change.value.id !== seed.id) return;
    const thread = change.value;
    const previous = seed.lastUserTurnChoices;
    const next = thread.lastUserTurnChoices;

    if (!thread.deletedAt && previous && next && equals(ui.ComposerTurnChoicesSchema, previous, next)) return;
    receive(latestThreadChoices([thread]));
    refresh();
  });

  return { value, receive };
}
