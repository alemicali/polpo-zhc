/**
 * A computer's live view and take control (src/sandbox/desktop.ts, computer-control.ts on the
 * server): who holds its desktop, agents' requests for a person, and a viewer's VNC access.
 */

/** Who holds a computer's desktop: the agent (default; people watch view-only) or a person. */
export type ComputerControlHolder = "agent" | "person";

export type ComputerTakeoverStatus = "pending" | "in_control" | "released" | "timeout" | "cancelled";

/** An agent's request for a person to take control (request_computer_takeover: a login, 2FA, a CAPTCHA). */
export interface ComputerTakeoverRequest {
  id: string;
  computerId: string;
  agent: string;
  reason: string;
  url?: string;
  whatToDo?: string;
  createdAt: string;
  /** When the agent stops waiting. */
  expiresAt: string;
  status: ComputerTakeoverStatus;
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
  processes?: { display: boolean; wm: boolean; vnc: boolean; ws: boolean; installed: boolean };
  note?: string;
  error?: string;
  startedAt?: string;
}

/** GET /computers/:id/desktop (and the start, stop, takeover and release answers). */
export interface ComputerDesktopView {
  desktop: ComputerDesktopStatus;
  control: ComputerControl;
  /**
   * viewer=1 (and start/takeover/release), while the live view runs: this person's VNC password
   * (full control only while they hold the computer) and the WebSocket path (noVNC).
   */
  viewer?: { mode: "control" | "view"; password: string; path: string };
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
