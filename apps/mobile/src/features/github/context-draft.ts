import type { github } from "@canopy/contracts";
import { publishPrDraft } from "./draft-events";

const pending = new Map<string, github.PullRequestContextResponse>();

export const putContext = (id: string, context: github.PullRequestContextResponse) => {
  pending.set(id, context);
  publishPrDraft(id);
};

export const takeContext = (id: string) => {
  const value = pending.get(id);
  pending.delete(id);

  return value;
};
