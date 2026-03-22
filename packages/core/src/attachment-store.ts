/**
 * Attachment metadata store — tracks files attached to chat sessions.
 *
 * The actual file content is managed by the FileSystem abstraction.
 * This store only persists metadata (filename, mimeType, size, path).
 */

export interface Attachment {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Relative path within the workspace (e.g. "attachments/{sessionId}/{filename}") */
  path: string;
  createdAt: string;
}

export interface AttachmentStore {
  save(attachment: Attachment): Promise<void>;
  getBySession(sessionId: string): Promise<Attachment[]>;
  get(id: string): Promise<Attachment | undefined>;
  delete(id: string): Promise<boolean>;
  deleteBySession(sessionId: string): Promise<number>;
}
