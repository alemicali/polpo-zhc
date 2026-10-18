/** What a voice reply says: the text without markdown, code blocks or link targets, within the TTS limit. */
export function speakableText(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 4000 ? `${plain.slice(0, 3990)}…` : plain;
}
