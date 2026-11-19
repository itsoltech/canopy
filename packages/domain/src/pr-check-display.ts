import type { ui } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { plural } from "./humanize.ts";
import { listOf, str, type JsonObject } from "./json.ts";
import { checkOutcome, type PrCheckEvent } from "./pr-check-watch.ts";

/**
 * CI check notes and watch calls for the timeline (docs/agent-bus.md, "Checki CI"), shared by web and mobile:
 * one system line per note, in words, with the pull request it is about.
 */

export interface ChecksNoteLine {
  readonly text: string;
  readonly icon: IconName;
  readonly tone: "failed" | "passed" | "neutral";
  /** "owner/repo#123" for the link to the pull request. */
  readonly pullRequest: string;
  /** "New commit 1a2b3c4" when the watch followed a commit since its previous note. */
  readonly commit: string;
}

function ended(reason: string): Pick<ChecksNoteLine, "text" | "icon"> {
  switch (reason) {
    case "passed":
      return { text: "All checks passed", icon: "check-circle" };
    case "conflict":
      return { text: "Merge conflicts block this pull request", icon: "git-pull-request" };
    case "merged":
      return { text: "Pull request merged", icon: "git-merge" };
    case "closed":
      return { text: "Pull request closed", icon: "git-pull-request-closed" };
    case "timeout":
      return { text: "Stopped watching checks at the time limit", icon: "eye-slash" };
    case "no_checks":
      return { text: "No checks reported in 10 min", icon: "eye-slash" };
    case "access":
      return { text: "Stopped watching checks without access", icon: "eye-slash" };
    case "unlinked":
      return { text: "Stopped watching checks of an unlinked pull request", icon: "eye-slash" };
    default:
      return { text: "Stopped watching checks", icon: "eye-slash" };
  }
}

function named(note: ui.PullRequestChecksNote, verb: string): string {
  const count = note.checks.length + note.omitted;

  return count === 1 && note.checks[0] ? `${note.checks[0].name} ${verb}` : `${count} checks ${verb}`;
}

function headline(note: ui.PullRequestChecksNote): Pick<ChecksNoteLine, "text" | "icon" | "tone"> {
  const failedNamed = note.checks.some((c) => checkOutcome(c.state) === "failed");

  switch (note.event) {
    case "failure":
      return { text: named(note, "failed"), icon: "x-circle", tone: "failed" };
    case "each":
      return failedNamed
        ? { text: named(note, "finished, with failures"), icon: "x-circle", tone: "failed" }
        : { text: named(note, "finished"), icon: "check-circle", tone: "passed" };
    case "complete":
      return note.failed > 0
        ? { text: `${note.failed} of ${plural(note.total, "check")} failed`, icon: "x-circle", tone: "failed" }
        : { text: `All ${plural(note.total, "check")} passed`, icon: "check-circle", tone: "passed" };
    default:
      return { ...ended(note.reason), tone: note.reason === "passed" ? "passed" : "neutral" };
  }
}

export function checksNoteLine(note: ui.PullRequestChecksNote): ChecksNoteLine {
  return {
    ...headline(note),
    pullRequest: `${note.repository}#${note.number}`,
    commit: note.headChanged ? `New commit ${note.headSha.slice(0, 7)}` : "",
  };
}

const EVENT_WORDS: Record<PrCheckEvent, string> = {
  failure: "a check fails",
  complete: "all checks finish",
  each: "each check finishes",
};

/** watch_pr_checks in words: the pull request, when the agent hears back, until when (or that nothing waits). */
export function watchCallFacts(args: JsonObject, result: JsonObject): string[] {
  const asked = listOf(args["notify_on"]);

  const events = (asked.length > 0 ? asked : ["failure", "complete"]).flatMap((e) =>
    e === "failure" || e === "complete" || e === "each" ? [EVENT_WORDS[e]] : [],
  );

  const until = Date.parse(str(result["until"]));

  return [
    str(result["pull_request"]) || str(args["pull_request"]),
    result["watching"] === false
      ? result["end_reason"]
        ? ended(str(result["end_reason"])).text
        : "All checks already passed"
      : events.length > 0
        ? `Tells this agent when ${events.join(" or ")}`
        : "",
    Number.isNaN(until)
      ? ""
      : `Until ${new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
  ].filter((fact) => fact !== "");
}
