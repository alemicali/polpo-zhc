/**
 * A computer's live view and take control (src/sandbox/desktop.ts, computer-control.ts on the
 * server): who holds its desktop, agents' requests for a person, and a viewer's access (never a
 * VNC password: the server answers the VM's VNC authentication itself).
 */

/** Who holds a computer's desktop: the agent (default; people watch view-only) or a person. */
export type ComputerControlHolder = "agent" | "person";

export type ComputerTakeoverStatus = "pending" | "in_control" | "released" | "timeout" | "cancelled";

/**
 * soft: optional help (when nobody takes over in time the agent goes on without it); hard: blocking
 * (a CAPTCHA, a phone or app verification, a login wall): when nobody takes over in time its task is
 * paused and the request stays open until a person completes it (which resumes the task).
 */
export type ComputerTakeoverLevel = "soft" | "hard";

/** An agent's request for a person to take control (request_computer_takeover: a login, 2FA, a CAPTCHA). */
export interface ComputerTakeoverRequest {
  id: string;
  computerId: string;
  agent: string;
  reason: string;
  url?: string;
  whatToDo?: string;
  createdAt: string;
  /** When the agent stops waiting (hard, in a task: when its task pauses). */
  expiresAt: string;
  status: ComputerTakeoverStatus;
  /** Absent: soft. */
  level?: ComputerTakeoverLevel;
  /** A hard request nobody took in time: its task is paused, the request stays open (never expires). */
  parkedAt?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  takenBy?: string;
  takenAt?: string;
  endedAt?: string;
  /** The person's note to the agent when giving control back. */
  note?: string;
}

export interface ComputerControl {
  computerId: string;
  holder: ComputerControlHolder;
  /** The person holding it (member email, or "someone" without member sign-in). */
  person?: string;
  since?: string;
  lastNote?: string;
  lastReleasedAt?: string;
  /** Open requests first, then the recent ones. */
  requests: ComputerTakeoverRequest[];
  open: ComputerTakeoverRequest[];
}

export type ComputerDesktopState = "running" | "stopped" | "machine-off" | "unsupported";

export interface ComputerDesktopStatus {
  computerId: string;
  state: ComputerDesktopState;
  /** The X display headed browsers open on (":99"). */
  display: string;
  /** Its screen, "WIDTHxHEIGHT": the running display's, else the computer's desktop.size (default "1280x800"). */
  size?: string;
  processes?: {
    display: boolean; wm: boolean; vnc: boolean; ws: boolean; installed: boolean;
    /** The desktop session: XFCE, or openbox when XFCE could not be installed. */
    session?: "xfce" | "openbox";
    /** The running display's size. */
    size?: string;
  };
  note?: string;
  error?: string;
  startedAt?: string;
}

/** GET /computers/:id/desktop (and the start, stop, takeover and release answers). */
export interface ComputerDesktopView {
  desktop: ComputerDesktopStatus;
  control: ComputerControl;
  /**
   * viewer=1 (and start/takeover/release), while the live view runs: this person's role (control
   * only while they hold the computer: the server lets their input through, decided per message)
   * and the WebSocket path for noVNC (security type None: no password ever reaches the browser).
   */
  viewer?: { mode: "control" | "view"; path: string };
}

/** The computer:takeover event. */
export interface ComputerTakeoverEvent {
  id: string;
  action: "requested" | "taken" | "released" | "timeout" | "cancelled" | "desktop-started" | "desktop-stopped";
  holder: ComputerControlHolder;
  person?: string;
  requestId?: string;
  agent?: string;
  reason?: string;
  url?: string;
  note?: string;
  taskId?: string;
  sessionId?: string;
}

/**
 * What runs on a computer now: POST /computers/:id/stop and /restart refuse with 409
 * COMPUTER_BUSY and this in the error's details.busy, unless { force: true }.
 */
export interface ComputerBusy {
  /** Task runs in progress on it (assigned or in_progress tasks whose running run is on it). */
  tasks: Array<{ taskId: string; title: string; status: string; runId: string; agent?: string }>;
  /** Live agent harness sessions on it (tasks and chats). */
  sessions: Array<{ key: string; sessionId?: string; agent: string; harness: string; scope: "task" | "chat"; state: string; taskId?: string; chatSessionId?: string }>;
}

/** POST /computers/:id/{start,stop,restart,reset}: the computer (stop: 202 at once, status "stopping"). */
export interface ComputerControlResult {
  id: string;
  name?: string;
  kind: string;
  status: string;
  lastError?: string;
  notice?: string;
  /** reset: the wipe is done, the new machine comes on its next use. */
  note?: string;
  [key: string]: unknown;
}
