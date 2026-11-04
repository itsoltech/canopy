/** Source URLs arrive validated by the gateway; retain the host/repository for compact lists. */
export function librarySource(url: string | undefined): string {
  if (!url) return "Uploaded files";
  const source = new URL(url);

  return `${source.host}${source.pathname.replace(/\.git$/, "")}`;
}
