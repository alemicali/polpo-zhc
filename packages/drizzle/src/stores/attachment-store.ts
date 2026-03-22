import { eq } from "drizzle-orm";
import type { AttachmentStore, Attachment } from "@polpo-ai/core/attachment-store";
import type { Dialect } from "../utils.js";

type AnyTable = any;

export class DrizzleAttachmentStore implements AttachmentStore {
  constructor(
    private db: any,
    private attachments: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToAttachment(row: any): Attachment {
    return {
      id: row.id,
      sessionId: row.sessionId,
      ...(row.messageId ? { messageId: row.messageId } : {}),
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      path: row.path,
      createdAt: row.createdAt,
    };
  }

  async save(attachment: Attachment): Promise<void> {
    await this.db.insert(this.attachments).values({
      id: attachment.id,
      sessionId: attachment.sessionId,
      messageId: attachment.messageId ?? null,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      path: attachment.path,
      createdAt: attachment.createdAt,
    });
  }

  async getBySession(sessionId: string): Promise<Attachment[]> {
    const rows: any[] = await this.db.select().from(this.attachments)
      .where(eq(this.attachments.sessionId, sessionId));
    return rows.map((r) => this.rowToAttachment(r));
  }

  async get(id: string): Promise<Attachment | undefined> {
    const rows: any[] = await this.db.select().from(this.attachments)
      .where(eq(this.attachments.id, id));
    return rows.length > 0 ? this.rowToAttachment(rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(this.attachments)
      .where(eq(this.attachments.id, id));
    const affected = result?.rowsAffected ?? result?.rowCount ?? result?.changes ?? 0;
    return affected > 0;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const result = await this.db.delete(this.attachments)
      .where(eq(this.attachments.sessionId, sessionId));
    return result?.rowsAffected ?? result?.rowCount ?? result?.changes ?? 0;
  }
}
