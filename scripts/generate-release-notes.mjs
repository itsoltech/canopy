import { generateNotes } from "@semantic-release/release-notes-generator";
import { limitReleaseBody } from "./release-body.mjs";

/** Commit bodies can contain entire PR descriptions. Only headers belong in the release summary. */
export async function generateReleaseNotes(options, context) {
  const notes = await generateNotes(
    {
      ...options,
      writerOpts: {
        ...options.writerOpts,
        commitGroupsSort: (a, b) => {
          const order = ["Features", "Bug Fixes", "Performance Improvements"];
          const rank = (title) => (order.includes(title) ? order.indexOf(title) : order.length);

          return rank(a.title) - rank(b.title) || a.title.localeCompare(b.title);
        },
      },
    },
    {
      ...context,
      commits: context.commits.map((commit) => ({ ...commit, message: commit.message.split(/\r?\n/)[0] })),
    },
  );

  const repo = context.options.repositoryUrl.replace(/\.git$/, "");
  const from = context.lastRelease.gitTag || context.lastRelease.gitHead;
  const to = context.nextRelease.gitTag || context.nextRelease.gitHead;

  return limitReleaseBody(notes, `${repo}/compare/${from}...${to}`);
}
