import type { ThreadState } from "./ThreadScreen";
import { ThreadSecrets } from "./ThreadSecrets";
import { QuestionPanel } from "./questions/QuestionPanel";
import { SubagentSummary } from "./SubagentPanel";

export function ThreadRequests({ state }: { state: ThreadState }) {
  const disabled = state.home.away || state.stream.connection !== "live";

  return (
    <>
      <ThreadSecrets secrets={state.snapshot?.secrets ?? []} disabled={disabled} />
      <QuestionPanel
        interactions={state.interactions}
        items={state.snapshot?.items}
        subagents={state.subagents}
        disabled={disabled}
      />
      <SubagentSummary threads={state.subagents} obscured={Boolean(state.message.trigger)} />
    </>
  );
}
