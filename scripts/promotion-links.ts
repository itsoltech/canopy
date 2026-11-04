/** Only explicit linking lines, never incidental #numbers or hexadecimal words. */
export function promotionLinks(message: string) {
  const prs: number[] = [];
  const shas: string[] = [];

  const prFooter =
    /^(?:(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|refs)[ \t]*:?[ \t]+|follow-up to[ \t]+|fixes an earlier change:[ \t]+)#(\d+)[ \t]*$/gim;

  for (const match of message.matchAll(prFooter)) prs.push(Number(match[1]));

  for (const match of message.matchAll(/^Refs:[ \t]+([a-f0-9]{7,40})[ \t]*$/gim)) shas.push(match[1]!.toLowerCase());

  for (const match of message.matchAll(/^This reverts commit ([a-f0-9]{7,40})\.?[ \t]*$/gim))
    shas.push(match[1]!.toLowerCase());

  return { prs, shas };
}
