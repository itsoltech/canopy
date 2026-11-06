import { humanizeKey } from "@canopy/domain/humanize";
import { isString, type JsonObject } from "@canopy/domain/json";
import { Markdown } from "../../../ui/markdown";
import { Section } from "./parts";

/**
 * A tool whose input and result are prose (Skill, ExitPlanMode; web: MarkdownBody): its long text arguments and
 * its result as markdown. Short arguments stay in "Show raw".
 */
export function MarkdownBody({ input, result }: { input: JsonObject; result: string }) {
  const prose = Object.entries(input).flatMap(([key, value]) =>
    isString(value) && (value.includes("\n") || value.length > 120) ? [[key, value] as const] : [],
  );

  return (
    <>
      {prose.map(([key, text]) => (
        <Section key={key} label={humanizeKey(key)}>
          <Markdown text={text} />
        </Section>
      ))}
      {result.trim() ? (
        <Section label="Result">
          <Markdown text={result.trim()} />
        </Section>
      ) : null}
    </>
  );
}
