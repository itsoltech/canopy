import { Fragment } from "react";
import { githubHtmlParts } from "@canopy/domain/github-images";
import { useMarkdownScope } from "./scope";

export function Html({ text }: { text: string }) {
  const { image } = useMarkdownScope();

  return githubHtmlParts(text).map((part, index) => (
    <Fragment key={index}>
      {part.kind === "text" ? part.text : part.kind === "br" ? "\n" : image?.(part.image)}
    </Fragment>
  ));
}
