export function analyzeCommits(
  config: { parserOpts?: { noteKeywords?: string[] } },
  context: {
    commits: { hash: string; message: string }[];
    lastRelease: { version: string };
    logger: { log: (...args: string[]) => void };
  },
): Promise<string | null>;
