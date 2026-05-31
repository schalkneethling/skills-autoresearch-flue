export type MountedFile = { path: string; contents: string };

const MAX_FILE_CHARS = 80_000;
const MAX_FILE_SET_CHARS = 240_000;

export function formatFileSet(files: MountedFile[], label: string): string {
  if (files.length === 0) {
    return "(none)";
  }
  let remainingChars = MAX_FILE_SET_CHARS;
  const formatted: string[] = [];
  let omittedFiles = 0;

  for (const file of files) {
    const separatorOverhead = formatted.length > 0 ? "\n\n".length : 0;
    const heading = `### ${file.path}\n\n`;
    const fenceOverhead = fenced("").length;
    const renderedOverhead = separatorOverhead + heading.length + fenceOverhead;

    if (remainingChars <= renderedOverhead) {
      omittedFiles++;
      continue;
    }

    const maxContentsChars = Math.min(MAX_FILE_CHARS, remainingChars - renderedOverhead);
    const contents = truncateText(file.contents, maxContentsChars, `${label}/${file.path}`);
    remainingChars -= renderedOverhead + contents.length;
    formatted.push(`${heading}${fenced(contents)}`);
  }

  if (omittedFiles > 0) {
    formatted.push(
      `[${omittedFiles} file(s) omitted from ${label}; ${MAX_FILE_SET_CHARS} char file-set budget exhausted.]`,
    );
  }

  return formatted.join("\n\n");
}

export function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function fenced(contents: string): string {
  return `\`\`\`\n${contents}\n\`\`\``;
}

function truncateText(contents: string, maxChars: number, label: string): string {
  if (contents.length <= maxChars) {
    return contents;
  }
  if (maxChars <= 0) {
    return "";
  }
  const keptChars = Math.max(0, maxChars - 128);
  const marker = `\n\n[truncated ${contents.length - keptChars} chars from ${label}; kept first ${keptChars} chars]\n`;
  return `${contents.slice(0, keptChars)}${marker}`.slice(0, maxChars);
}
