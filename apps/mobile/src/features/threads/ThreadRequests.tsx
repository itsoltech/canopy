import type { ThreadState } from "./ThreadScreen";
import { ThreadSecrets } from "./ThreadSecrets";

/** Secret requests above the tray; the watchers of subagents' requests stay mounted for the tray's request row. */
export function ThreadRequests({ state }: { state: ThreadState }) {
  const disabled = state.home.away || state.stream.connection !== "live";

  return (
    <>
      <ThreadSecrets secrets={state.snapshot?.secrets ?? []} disabled={disabled} />
      {state.requests.watchers}
    </>
  );
}
