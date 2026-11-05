/** Short event text, separate from the model's completion report and its transcript. */
export function threadNotice(title: string, status: string, computer = ""): string {
  const subject = `“${title || "Thread"}”${computer ? ` on ${computer}` : ""}`;

  switch (status) {
    case "completed":
      return `${subject} finished`;
    case "failed":
      return `${subject} failed`;
    case "interrupted":
      return `${subject} was interrupted`;
    case "cancelled":
      return `${subject} was cancelled`;
    default:
      return `${subject} ended`;
  }
}
