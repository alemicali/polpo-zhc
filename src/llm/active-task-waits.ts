export interface ActiveTaskWait {
  toolCallId: string;
  turnId?: string;
  sessionId: string;
  taskId: string;
  targetStatus?: string;
  detach: (backgroundWaitId: string) => void;
}

class ActiveTaskWaitRegistry {
  private readonly waits = new Map<string, ActiveTaskWait>();

  register(wait: ActiveTaskWait): () => void {
    this.waits.set(wait.toolCallId, wait);
    return () => {
      if (this.waits.get(wait.toolCallId) === wait) this.waits.delete(wait.toolCallId);
    };
  }

  get(toolCallId: string, sessionId?: string): ActiveTaskWait | undefined {
    const wait = this.waits.get(toolCallId);
    return wait && (!sessionId || wait.sessionId === sessionId) ? wait : undefined;
  }
}

export const activeTaskWaitRegistry = new ActiveTaskWaitRegistry();
