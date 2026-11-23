import { getContext, setContext, type Snippet } from "svelte";
import type { MarkdownImage } from "@canopy/domain/markdown";

export type ImageRenderer = Snippet<[MarkdownImage]>;

const key = Symbol("markdown-images");
export const provideImages = (scope: { readonly render: ImageRenderer | undefined }) => setContext(key, scope);
export const useImages = () => getContext<{ readonly render: ImageRenderer | undefined }>(key);
