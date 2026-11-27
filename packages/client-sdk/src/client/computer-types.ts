/**
 * A computer's live view and take control (src/sandbox/desktop.ts, computer-control.ts on the
 * server): who holds its desktop, agents' requests for a person, and a viewer's access (never a
 * VNC password: the server answers the VM's VNC authentication itself).
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
