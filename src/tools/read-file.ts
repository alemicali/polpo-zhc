/**
 * What the `read` tool shows of a file: the selected lines only, counted without a phantom last
 * line (a trailing line break ends the last line, it does not start one), CRLF lines as plain
 * lines, the byte order mark dropped. Files on this machine are streamed, so memory does not grow
 * with the file; other FileSystems (a remote VM) send the whole file, which is why files over
 * {@link MAX_READ_FILE_BYTES} are refused before any byte is read. Binary files and images are
 * recognised from their first bytes and never decoded.
 *
 * The streaming selection, the binary/image checks and the size refusal follow Pi's read tool
 * (`@earendil-works/pi-coding-agent` 1.6, src/core/tools/read.ts, MIT License, Copyright (c)
 * Mario Zechner); Polpo keeps its own line numbers and caps.
 */

import { createReadStream } from "node:fs";
import { extname } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { NodeFileSystem } from "../adapters/node-filesystem.js";

/** Files larger than this are not read (20 MB). */
export const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;
/** Bytes looked at to tell binary files apart. */
const SNIFF_BYTES = 8192;

export interface SelectedLine {
  /** The line's text, cut after `maxLineChars` characters. */
  text: string;
  /** The line's full length in characters. */
  length: number;
}

export type ReadSelection =
  | { kind: "text"; lines: SelectedLine[]; totalLines: number; size: number }
  | { kind: "image"; mimeType: string; size: number }
  | { kind: "binary"; size: number; what?: string }
  | { kind: "too_large"; size: number }
  | { kind: "directory" };

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff", ".ico": "image/x-icon", ".heic": "image/heic", ".avif": "image/avif",
};

/** An image's MIME type from its first bytes (or, for formats without a clear signature, its extension). */
export function sniffImage(head: Uint8Array, path: string): string | undefined {
  const b = head;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  const byExtension = IMAGE_EXTENSIONS[extname(path).toLowerCase()];
  if (byExtension && (b.length === 0 || isBinary(b) || ascii(0, 2) === "BM")) return byExtension;
  return undefined;
}

/** NUL bytes in the first bytes: not text (UTF-16 files count as binary too). */
export function isBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

function classify(head: Uint8Array, path: string, size: number): ReadSelection | undefined {
  const image = sniffImage(head, path);
  if (image) return { kind: "image", mimeType: image, size };
  if (head.length >= 5 && String.fromCharCode(...head.subarray(0, 5)) === "%PDF-") return { kind: "binary", size, what: "a PDF" };
  if (isBinary(head)) return { kind: "binary", size };
  return undefined;
}

/** Collects lines [start, start + limit) from text pieces, counting all of them. */
class LineSelector {
  private carry = "";
  private carryLength = 0;
  private line = 0;
  private storedChars = 0;
  readonly lines: SelectedLine[] = [];
  private sawText = false;
  private lastChar = "";

  constructor(private readonly start: number, private readonly end: number, private readonly maxStoredChars: number, private readonly maxLineChars: number) {}

  private selected(): boolean {
    return this.line >= this.start && this.line < this.end && this.storedChars <= this.maxStoredChars;
  }

  private append(piece: string): void {
    if (piece.length === 0) return;
    if (this.selected() && this.carry.length <= this.maxLineChars) this.carry += piece;
    this.carryLength += piece.length;
    this.lastChar = piece[piece.length - 1]!;
  }

  private finish(): void {
    if (this.selected()) {
      // a CRLF line is shown without its CR
      const length = this.carryLength > 0 && this.lastChar === "\r" ? this.carryLength - 1 : this.carryLength;
      const text = this.carry.slice(0, Math.min(length, this.maxLineChars));
      this.lines.push({ text, length });
      this.storedChars += text.length + 1;
    }
    this.line++;
    this.carry = "";
    this.carryLength = 0;
    this.lastChar = "";
  }

  push(text: string): void {
    if (text.length > 0) this.sawText = true;
    let position = 0;
    for (;;) {
      const nl = text.indexOf("\n", position);
      if (nl === -1) { this.append(text.slice(position)); return; }
      this.append(text.slice(position, nl));
      this.finish();
      position = nl + 1;
    }
  }

  /** Total number of lines; an unterminated last line counts, a final line break does not start one. */
  end_(): number {
    if (this.carryLength > 0) this.finish();
    return this.sawText ? this.line : 0;
  }
}

/**
 * The lines [start, start + limit) of `path` (0-based start), at most about `maxStoredChars`
 * characters of them, each cut after `maxLineChars`; the total line count always.
 */
export async function selectFileLines(
  fs: FileSystem,
  path: string,
  opts: { start: number; limit: number; maxStoredChars: number; maxLineChars: number; signal?: AbortSignal },
): Promise<ReadSelection> {
  const st = await fs.stat(path);
  if (st.isDirectory) return { kind: "directory" };
  // a FIFO or device would block or never end (node's stat follows symlinks; other FileSystems may not)
  if (fs instanceof NodeFileSystem && !st.isFile) return { kind: "binary", size: st.size, what: "not a regular file" };
  const imageByName = IMAGE_EXTENSIONS[extname(path).toLowerCase()];
  if (st.size > MAX_READ_FILE_BYTES) return imageByName ? { kind: "image", mimeType: imageByName, size: st.size } : { kind: "too_large", size: st.size };
  const selector = new LineSelector(opts.start, opts.start + opts.limit, opts.maxStoredChars, opts.maxLineChars);
  // ignoreBOM: false drops a UTF-8 byte order mark, which is not part of the text
  const decoder = new TextDecoder("utf-8");

  if (fs instanceof NodeFileSystem) {
    let first = true;
    let size = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
      if (opts.signal?.aborted) throw new Error("Operation aborted");
      const bytes = chunk as Buffer;
      if (first) {
        first = false;
        const other = classify(bytes.subarray(0, SNIFF_BYTES), path, st.size);
        if (other) return other;
      }
      size += bytes.length;
      selector.push(decoder.decode(bytes, { stream: true }));
    }
    selector.push(decoder.decode());
    return { kind: "text", lines: selector.lines, totalLines: selector.end_(), size };
  }

  const bytes = fs.readFileBuffer ? await fs.readFileBuffer(path) : new TextEncoder().encode(await fs.readFile(path));
  const other = classify(bytes.subarray(0, SNIFF_BYTES), path, bytes.byteLength);
  if (other) return other;
  selector.push(decoder.decode(bytes));
  return { kind: "text", lines: selector.lines, totalLines: selector.end_(), size: bytes.byteLength };
}
