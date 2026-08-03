export function markdownText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/([\\`*_[\]<>#|])/gu, "\\$1");
}
