import { getContext, setContext, type Snippet } from "svelte";
import type { GitHubImage } from "@canopy/domain/github-images";

export type ImageRenderer = Snippet<[GitHubImage]>;

const key = Symbol("markdown-images");
export const provideImages = (scope: { readonly render: ImageRenderer | undefined }) => setContext(key, scope);
export const useImages = () => getContext<{ readonly render: ImageRenderer | undefined }>(key);
