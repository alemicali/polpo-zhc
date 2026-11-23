export interface DocComment {
  id: string;
  body: string;
  quote?: string;
  length?: number;
  resolved?: boolean;
}

export const encodeDocComment = (comment: DocComment) => encodeURIComponent(JSON.stringify(comment));

export function decodeDocComment(payload: unknown): DocComment | undefined {
  if (typeof payload !== "string" || payload.length > 40_000) return undefined;
  try {
    const data: Partial<DocComment> = JSON.parse(decodeURIComponent(payload));
    if (typeof data.id !== "string" || !/^[\w-]{1,20}$/.test(data.id)) return undefined;
    if (typeof data.body !== "string" || !data.body.trim() || data.body.length > 2000) return undefined;
    return {
      id: data.id,
      body: data.body,
      ...(typeof data.quote === "string" && data.quote.length <= 1000 ? { quote: data.quote } : {}),
      ...(typeof data.length === "number" && Number.isInteger(data.length) && data.length > 0 && data.length <= 3000
        ? { length: data.length } : {}),
      ...(data.resolved === true ? { resolved: true } : {}),
    };
  } catch {
    return undefined;
  }
}
