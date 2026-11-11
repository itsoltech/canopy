import type { github } from "@canopy/contracts";

const pending = new Map<string, github.PullRequestContextResponse>();
export const putContext = (id: string, context: github.PullRequestContextResponse) => pending.set(id, context);

export const takeContext = (id: string) => {
  const value = pending.get(id);
  pending.delete(id);

  return value;
};
