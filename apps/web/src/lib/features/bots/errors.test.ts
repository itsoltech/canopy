import { expect, test } from "bun:test";
import { replyFailure } from "./errors.ts";

test("technical failures become a reason, and say when a different model is the fix", () => {
  expect(replyFailure("Model endpoint returned HTTP 400")).toEqual({ reason: "the model isn't available", model: true });
  expect(replyFailure('"default" is a Claude Code alias, not a model of the provider API; choose a concrete model')).toEqual({ reason: "the model isn't available", model: true });
  expect(replyFailure("Model endpoint returned HTTP 429").reason).toBe("the provider is rate limiting it");
  expect(replyFailure("Model endpoint returned HTTP 503").model).toBe(false);
  expect(replyFailure("Bot tool-round limit reached").reason).toBe("it hit its step limit");
  expect(replyFailure("Bot could not finish this turn").reason).toBe("something went wrong");
});
