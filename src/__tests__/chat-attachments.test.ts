import { describe, test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveChatUserMessage, resolveChatAttachmentReferences } from "../server/chat-attachments.js";
import { FileAttachmentStore } from "../stores/file-attachment-store.js";
import { chatRoutes, attachmentRoutes } from "@polpo-ai/server";
import { NodeFileSystem } from "../adapters/node-filesystem.js";

describe("chat attachment contract", () => {
  test("model file references resolve from the project root, independently of tool cwd", () => {
    expect(resolveChatAttachmentReferences("Read [file: workspace/attachments/chat-id/file-id.txt]", "/data/lumea"))
      .toBe("Read [file: /data/lumea/workspace/attachments/chat-id/file-id.txt]");
    expect(resolveChatAttachmentReferences("[file: workspace/attachments/../private.txt]", "/data/lumea"))
      .toBe("[file: workspace/attachments/../private.txt]");
  });
  test("photo-only and document messages survive history reload with byte-exact downloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-attachments-test-"));
    try {
      await mkdir(join(dir, ".polpo"));
      const store = new FileAttachmentStore(join(dir, ".polpo"));
      const messages: any[] = [];
      const sessions: any = { addMessage: async (sid: string, role: string, content: string) => {
        const m = { id: `message-${messages.length}`, role, content, ts: new Date().toISOString() }; messages.push(m); return m;
      }, getMessages: async () => messages, getSession: async (id: string) => ({ id }) };
      const bytes = Buffer.from([0, 1, 2, 128, 255]);
      const content: any = [{ type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } },
        { type: "file", file: { filename: "report.pdf", file_data: `data:application/pdf;base64,${bytes.toString("base64")}` } }];
      const first = await saveChatUserMessage(sessions, store, dir, "session-test", content);
      const second = await saveChatUserMessage(sessions, store, dir, "session-test", content);
      expect(first.content).toBe("");
      expect(first.attachments).toHaveLength(2);
      expect(first.attachments[0].path).not.toBe(second.attachments[0].path);
      expect(first.modelContent[0].type).toBe("image_url");
      expect(first.modelContent[1]).toEqual({ type: "text", text: `[file: ${first.attachments[1].path}]` });
      const history = chatRoutes(() => ({ sessionStore: sessions, attachmentStore: store }));
      const response = await history.request('/sessions/session-test/messages');
      const data = await response.json() as any;
      expect(data.data.messages[0].attachments).toHaveLength(2);
      expect(JSON.stringify(data)).not.toContain('base64');
      const download = attachmentRoutes(() => ({ attachmentStore: new FileAttachmentStore(join(dir, '.polpo')), workDir: dir, fs: new NodeFileSystem() }));
      for (const a of first.attachments) {
        expect(await readFile(join(dir, a.path))).toEqual(bytes);
        const res = await download.request(`/${a.id}/download`);
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
      }
      await expect(saveChatUserMessage(sessions, store, dir, '../escape', content)).rejects.toThrow('Invalid');
      await expect(saveChatUserMessage(sessions, store, dir, 'session-test', [{ type: 'image_url', image_url: { url: 'https://localhost/private' } }])).rejects.toThrow('base64');
      await expect(saveChatUserMessage(sessions, store, dir, 'session-test', [{ type: 'file', file: { filename: 'bad.txt', file_data: 'data:text/plain;base64,!' } }])).rejects.toThrow();
      expect(messages).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
