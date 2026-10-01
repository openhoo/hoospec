/** Shared fence tracking keeps code examples out of ADR structure and metadata. */
export function markdownCodeLines(lines: string[]): Set<number> {
  const code = new Set<number>();
  let fence: { character: string; length: number } | null = null;
  lines.forEach((line, index) => {
    const delimiter = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      code.add(index);
      if (delimiter && delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
    } else if (delimiter) {
      code.add(index); fence = { character: delimiter[1][0], length: delimiter[1].length };
    }
  });
  return code;
}

export function markdownHeading(line: string) {
  const match = line.match(/^(#{1,6})[ \t]+(.+?)\s*$/);
  if (!match) return null;
  const name = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
  return name ? { level: match[1].length, keyword: match[1], name } : null;
}
