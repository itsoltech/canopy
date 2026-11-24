import { Schema } from "effect";

const argumentsSchema = Schema.Struct({
  branch: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(255)).annotate({
      description: "Exact name of the new Git branch to create from this thread's current HEAD.",
    }),
  ),
  path: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/), Schema.isMaxLength(32_767)).annotate({
      description:
        "Absolute path to an existing worktree root in this workspace repository, or to the configured workspace directory.",
    }),
  ),
  continuation: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(100_000)).annotate({
      description: "Work to do next. Queues a turn in the destination worktree after this turn finishes.",
    }),
  ),
}).pipe(
  Schema.refine(
    (args): args is typeof args & ({ branch: string; path?: never } | { branch?: never; path: string }) =>
      (args.branch !== undefined) !== (args.path !== undefined),
    { message: "Provide exactly one of branch or path." },
  ),
);

export const switchWorktree = {
  name: "switch_worktree",
  description:
    "Switch this thread's working directory as the final action of the current turn. Provide exactly one of branch or path. " +
    "Use branch to create a worktree on a new branch from the current commit. Uncommitted changes stay in the source worktree. " +
    "Use path for a worktree listed by Git in the same workspace repository, including one you created or the primary checkout. " +
    "Returns the destination cwd and branch. The next turn starts there. Include continuation to queue remaining work.",
  args: argumentsSchema,
  mutates: true,
} as const;
