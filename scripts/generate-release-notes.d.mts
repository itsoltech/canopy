export function generateReleaseNotes(
  options: { preset: string },
  context: {
    cwd: string;
    commits: readonly { hash: string; message: string }[];
    lastRelease: { gitTag: string };
    nextRelease: { version: string; gitTag: string };
    options: { repositoryUrl: string };
  },
): Promise<string>;
