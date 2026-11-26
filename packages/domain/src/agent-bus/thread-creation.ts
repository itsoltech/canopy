import { Schema } from "effect";
import { isEntityId } from "../computers.ts";
import { SPAWN_PERMISSION_MODES } from "../permission-modes.ts";

export const Prompt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000));

export const Notify = Schema.Boolean.annotate({
  description:
    "When true (default), you get a new message in this thread once the target finishes the turn, so you can continue other work instead of waiting.",
});

const ProjectSelector = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(200)).annotate({
  description: "Project name or ID.",
});

const WorkerSelector = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(200)).annotate({
  description: "Worker name or ID.",
});

export const ListAgents = Schema.Struct({
  project: Schema.optionalKey(ProjectSelector.annotate({ description: "Project name or ID to filter placements." })),
  worker: Schema.optionalKey(
    WorkerSelector.annotate({ description: "Worker name or ID whose configured workspaces and models to list." }),
  ),
});

const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const BaseRef = Schema.String.check(Schema.isMaxLength(250)).annotate({
  description: "Branch, tag or commit to use as the base of a new worktree.",
});

const PlacementId = Schema.String.check(Schema.makeFilter(isEntityId));

const executionFields = {
  instructions: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
      description: "Role or standing instructions added to the new thread's system instructions.",
    }),
  ),
  provider: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
      description:
        'Provider instance from list_agents, e.g. "antigravity/native" or "codex/cliproxyapi" (or just the provider name).',
    }),
  ),
  model: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: "Model ID from that provider's catalog in list_agents.",
    }),
  ),
  effort: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)).annotate({
      description: "Reasoning effort from the model's catalog in list_agents (e.g. low, medium, high).",
    }),
  ),
  service_tier: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)).annotate({
      description: "Execution speed from the model's service_tiers in list_agents. Use default for standard speed.",
    }),
  ),
  permission_mode: Schema.optionalKey(
    Schema.Literals(SPAWN_PERMISSION_MODES).annotate({
      description: "Permission mode for the new thread. Defaults to yours and can narrow access.",
    }),
  ),
  notify: Schema.optionalKey(Notify),
};

export const SpawnThread = Schema.Struct({
  workspace_mode: Schema.optionalKey(
    Schema.Literals(["checkout", "new_worktree", "inherit_parent", "default"]).annotate({
      description:
        "Defaults to inherit_parent (same directory/worktree). checkout uses the project checkout; new_worktree creates an isolated branch; default resolves the project's scoped setting.",
    }),
  ),
  base_ref: Schema.optionalKey(BaseRef),
  workspace_id: Schema.optionalKey(
    PlacementId.annotate({
      description:
        "A linked computer's workspace from list_agents. Creates the child at that home. Required for a remote spawn; fork is unavailable across computers.",
    }),
  ),
  project_id: Schema.optionalKey(PlacementId),
  title: Title.annotate({
    description: "Short label of the subagent's task, shown to the user (like a task name or description).",
  }),
  prompt: Prompt.annotate({
    description:
      "Task for the new agent. Include everything it needs; it does not see your context unless fork is true.",
  }),
  ...executionFields,
  fork: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Inherit this thread's history up to its last completed turn. Only on your own provider (omit provider).",
    }),
  ),
  interactions: Schema.optionalKey(
    Schema.Literals(["parent", "human"]).annotate({
      description:
        "Who answers the new thread's permission prompts and questions: parent (default) = you, via answer_interaction; human = the user in the UI.",
    }),
  ),
});

export const StartThread = Schema.Struct({
  project: Schema.optionalKey(ProjectSelector),
  worker: Schema.optionalKey(WorkerSelector),
  workspace: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4096)).annotate({
      description: "Configured workspace ID or path from list_agents.",
    }),
  ),
  workspace_mode: Schema.optionalKey(
    Schema.Literals(["checkout", "new_worktree", "default"]).annotate({
      description:
        "Use checkout for the configured directory, new_worktree for an isolated branch, or default for the placement's worktree setting.",
    }),
  ),
  base_ref: Schema.optionalKey(
    BaseRef.annotate({
      description: "Existing branch or full commit in the destination repository. Defaults to its default branch.",
    }),
  ),
  title: Title.annotate({ description: "Title of the new thread, shown to the user." }),
  prompt: Prompt.annotate({ description: "First task for the new thread. Include the context it needs." }),
  ...executionFields,
});
