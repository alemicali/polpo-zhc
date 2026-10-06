// Keep file contents inside one code block, even if they contain backticks.
export function mermaidCodeBlock(source: string): string {
  const longest = Math.max(2, ...Array.from(source.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}mermaid\n${source}\n${fence}`;
}
