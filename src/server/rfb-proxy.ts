/**
 * The RFB (VNC) protocol between a person's viewer (noVNC in the dashboard) and a computer's VNC
 * server (x11vnc in its VM), with the Polpo server in the middle:
 *
 * - towards the VM, the server is the VNC client: it completes the handshake itself, answering
 *   VNC Authentication with the computer's password (vnc-auth.ts), which therefore never reaches a
 *   browser, and reads the VM's ServerInit;
 * - towards the browser, the server is a VNC server with security type None (RFB 3.8, 3.7 and
 *   3.3 viewers), which hands the browser the VM's ServerInit once both sides are ready;
 * - after that, the VM's messages go to the browser as they are, and the browser's messages are
 *   parsed one by one (framing: SetEncodings, ClientCutText, extended clipboard, fences, QEMU…):
 *   input (keys, pointer, clipboard, desktop size, xvp) passes only while `canControl()` says this
 *   viewer holds the computer, asked per message when it arrives, so taking and giving back
 *   control are instant, without reconnecting. Everything else (SetPixelFormat, SetEncodings,
 *   FramebufferUpdateRequest, fences, continuous updates) passes untouched.
 *
 * A message the server cannot frame closes the connection (it never guesses a length).
 * Transport-agnostic: the WebSocket bridge (computer-desktop-ws.ts) feeds it bytes.
 */
import { vncAuthResponse } from "../sandbox/vnc-auth.js";

/** The largest client message accepted (clipboard text); larger closes the connection. */
export const RFB_MAX_CLIENT_MESSAGE = 16 * 1024 * 1024;

const SECURITY_NONE = 1;
const SECURITY_VNC = 2;
/** noVNC's extended PointerEvent (a 7th byte when the mask's marker bit is set). */
const ENCODING_EXTENDED_MOUSE_BUTTONS = -316;
/** Extended clipboard: the "caps" action (capability negotiation, no data). */
const CLIPBOARD_CAPS = 1 << 24;

export type RfbFailure = "auth" | "protocol" | "upstream";

export interface RfbProxyOptions {
  /** The VM's VNC password (VNC Authentication); never sent to the viewer. */
  password: string;
  /** Whether this viewer holds the computer now (asked for every input message). */
  canControl: () => boolean;
  toClient: (data: Buffer) => void;
  toServer: (data: Buffer) => void;
  /** The connection cannot go on (both sides are closed by the caller). */
  fail: (why: RfbFailure, message: string) => void;
}

/** A byte queue: chunks in, exact reads out. */
class Bytes {
  private buf: Buffer = Buffer.alloc(0);
  push(b: Buffer) { this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b; }
  get length() { return this.buf.length; }
  peek(n: number): Buffer | undefined { return this.buf.length >= n ? this.buf.subarray(0, n) : undefined; }
  take(n: number): Buffer | undefined {
    if (this.buf.length < n) return undefined;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  rest(): Buffer { const out = this.buf; this.buf = Buffer.alloc(0); return out; }
}

const VERSION = /^RFB (\d{3})\.(\d{3})\n$/;
/** The minor version spoken: 3, 7 or 8. */
const minorOf = (v: Buffer): number | undefined => {
  const m = VERSION.exec(v.toString("latin1"));
  if (!m || Number(m[1]) < 3) return undefined;
  if (Number(m[1]) > 3) return 8;
  const minor = Number(m[2]);
  return minor >= 8 ? 8 : minor === 7 ? 7 : 3;
};
const versionString = (minor: number) => Buffer.from(`RFB 003.00${minor}\n`, "latin1");
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

type ServerState = "version" | "security" | "challenge" | "result" | "reason" | "init" | "relay" | "failed";
type ClientState = "version" | "security" | "init" | "messages" | "failed";

/** One viewer's connection to one VM's VNC server. */
export class RfbProxy {
  private readonly server = new Bytes();
  private readonly client = new Bytes();
  private serverState: ServerState = "version";
  private clientState: ClientState = "version";
  private serverMinor = 8;
  private clientMinor = 8;
  private serverInit: Buffer | undefined;
  private initSent = false;
  private failed = false;
  private extendedMouse = false;
  /** Accepted client messages waiting for the VM's handshake to finish. */
  private readonly pendingToServer: Buffer[] = [];
  /** Counters (tests, diagnostics). */
  readonly stats = { passed: 0, dropped: 0 };

  constructor(private readonly o: RfbProxyOptions) {}

  /** The viewer connected: the server speaks first. */
  start(): void {
    this.o.toClient(versionString(8));
  }

  private fail(why: RfbFailure, message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.serverState = "failed";
    this.clientState = "failed";
    this.o.fail(why, message);
  }

  // ── the VM's side (the proxy is the VNC client) ─────────────────────

  fromServer(data: Buffer): void {
    if (this.failed) return;
    if (this.serverState === "relay") { this.o.toClient(data); return; }
    this.server.push(data);
    this.drainServer();
  }

  private drainServer(): void {
    for (;;) {
      if (this.failed) return;
      switch (this.serverState) {
        case "version": {
          const v = this.server.take(12);
          if (!v) return;
          const minor = minorOf(v);
          if (minor === undefined) return this.fail("upstream", "The computer's VNC server speaks an unknown protocol");
          this.serverMinor = minor;
          this.o.toServer(versionString(minor));
          this.serverState = "security";
          break;
        }
        case "security": {
          let types: number[];
          if (this.serverMinor === 3) {
            const t = this.server.take(4);
            if (!t) return;
            types = [t.readUInt32BE(0)];
            if (types[0] === 0) { this.serverState = "reason"; break; }
          } else {
            const n = this.server.peek(1);
            if (!n) return;
            if (n[0] === 0) { this.server.take(1); this.serverState = "reason"; break; }
            const list = this.server.take(1 + n[0]!);
            if (!list) return;
            types = [...list.subarray(1)];
          }
          if (types.includes(SECURITY_VNC)) {
            if (this.serverMinor !== 3) this.o.toServer(Buffer.from([SECURITY_VNC]));
            this.serverState = "challenge";
          } else if (types.includes(SECURITY_NONE)) {
            if (this.serverMinor !== 3) this.o.toServer(Buffer.from([SECURITY_NONE]));
            if (this.serverMinor === 8) this.serverState = "result";
            else this.clientInitToServer();
          } else {
            return this.fail("upstream", `The computer's VNC server offers no usable security type (${types.join(", ")})`);
          }
          break;
        }
        case "challenge": {
          const challenge = this.server.take(16);
          if (!challenge) return;
          this.o.toServer(vncAuthResponse(this.o.password, challenge));
          this.serverState = "result";
          break;
        }
        case "result": {
          const r = this.server.take(4);
          if (!r) return;
          if (r.readUInt32BE(0) === 0) { this.clientInitToServer(); break; }
          if (this.serverMinor === 8) {
            const len = this.server.peek(4);
            if (!len) return;
            const reason = this.server.take(4 + len.readUInt32BE(0));
            if (!reason) return;
            return this.fail("auth", `The computer's VNC server refused the password: ${reason.subarray(4).toString("utf8").slice(0, 200)}`);
          }
          return this.fail("auth", "The computer's VNC server refused the password");
        }
        case "reason": {
          const len = this.server.peek(4);
          if (!len) return;
          const reason = this.server.take(4 + len.readUInt32BE(0));
          if (!reason) return;
          return this.fail("upstream", `The computer's VNC server refused the connection: ${reason.subarray(4).toString("utf8").slice(0, 200)}`);
        }
        case "init": {
          const head = this.server.peek(24);
          if (!head) return;
          const nameLength = head.readUInt32BE(20);
          if (nameLength > 64 * 1024) return this.fail("upstream", "The computer's VNC server sent an invalid ServerInit");
          const init = this.server.take(24 + nameLength);
          if (!init) return;
          this.serverInit = Buffer.from(init);
          this.serverState = "relay";
          // the VM's handshake is done: what the viewer already sent goes now
          for (const m of this.pendingToServer.splice(0)) this.o.toServer(m);
          this.maybeSendServerInit();
          return;
        }
        default:
          return;
      }
    }
  }

  /** ClientInit towards the VM: always shared (several people may watch). */
  private clientInitToServer(): void {
    this.o.toServer(Buffer.from([1]));
    this.serverState = "init";
  }

  /** The viewer gets the VM's ServerInit once both handshakes are done; then the VM's bytes flow. */
  private maybeSendServerInit(): void {
    if (this.initSent || !this.serverInit || this.clientState !== "messages") return;
    this.initSent = true;
    this.o.toClient(this.serverInit);
    const early = this.server.rest();
    if (early.length) this.o.toClient(early);
  }

  // ── the viewer's side (the proxy is the VNC server) ─────────────────

  fromClient(data: Buffer): void {
    if (this.failed) return;
    this.client.push(data);
    this.drainClient();
  }

  private drainClient(): void {
    for (;;) {
      if (this.failed) return;
      switch (this.clientState) {
        case "version": {
          const v = this.client.take(12);
          if (!v) return;
          const minor = minorOf(v);
          if (minor === undefined) return this.fail("protocol", "Not a VNC viewer");
          this.clientMinor = minor;
          if (minor === 3) { this.o.toClient(u32(SECURITY_NONE)); this.clientState = "init"; }
          else { this.o.toClient(Buffer.from([1, SECURITY_NONE])); this.clientState = "security"; }
          break;
        }
        case "security": {
          const t = this.client.take(1);
          if (!t) return;
          if (t[0] !== SECURITY_NONE) return this.fail("protocol", "The viewer chose a security type that was not offered");
          if (this.clientMinor === 8) this.o.toClient(u32(0));
          this.clientState = "init";
          break;
        }
        case "init": {
          if (!this.client.take(1)) return; // ClientInit: the VM connection is always shared
          this.clientState = "messages";
          this.maybeSendServerInit();
          break;
        }
        case "messages": {
          const framed = this.frame();
          if (framed === undefined) return;
          if (framed === null) return this.fail("protocol", "The viewer sent a message the live view does not know");
          const message = this.client.take(framed.size)!;
          if (framed.input && !this.o.canControl()) { this.stats.dropped++; break; }
          if (framed.encodings) this.extendedMouse = framed.encodings.includes(ENCODING_EXTENDED_MOUSE_BUTTONS);
          this.stats.passed++;
          const copy = Buffer.from(message);
          if (this.serverState === "relay") this.o.toServer(copy);
          else this.pendingToServer.push(copy);
          break;
        }
        default:
          return;
      }
    }
  }

  /**
   * The next client message's size and kind: undefined while incomplete, null when it cannot be
   * framed. `input`: it acts on the desktop (only for the viewer holding control).
   */
  private frame(): { size: number; input: boolean; encodings?: number[] } | undefined | null {
    const head = this.client.peek(1);
    if (!head) return undefined;
    const need = (n: number) => this.client.peek(n);
    const sized = (size: number, input = false) => {
      if (size > RFB_MAX_CLIENT_MESSAGE) return null;
      return this.client.length >= size ? { size, input } : undefined;
    };
    switch (head[0]) {
      case 0: return sized(20); // SetPixelFormat
      case 2: { // SetEncodings
        const h = need(4);
        if (!h) return undefined;
        const n = h.readUInt16BE(2);
        const size = 4 + 4 * n;
        const all = need(size);
        if (!all) return undefined;
        const encodings: number[] = [];
        for (let i = 0; i < n; i++) encodings.push(all.readInt32BE(4 + 4 * i));
        return { size, input: false, encodings };
      }
      case 3: return sized(10); // FramebufferUpdateRequest
      case 4: return sized(8, true); // KeyEvent
      case 5: { // PointerEvent (7 bytes when extended mouse buttons are in use)
        const h = need(2);
        if (!h) return undefined;
        return sized(this.extendedMouse && (h[1]! & 0x80) ? 7 : 6, true);
      }
      case 6: { // ClientCutText; a negative length: extended clipboard
        const h = need(8);
        if (!h) return undefined;
        const length = h.readInt32BE(4);
        const size = 8 + Math.abs(length);
        if (size > RFB_MAX_CLIENT_MESSAGE) return null;
        if (length >= 0) return sized(size, true);
        if (Math.abs(length) < 4) return null;
        const f = need(12);
        if (!f) return undefined;
        // capability negotiation carries no clipboard data: it passes for everyone
        const caps = (f.readUInt32BE(8) & CLIPBOARD_CAPS) !== 0;
        return sized(size, !caps);
      }
      case 150: return sized(10); // EnableContinuousUpdates
      case 248: { // ClientFence
        const h = need(9);
        if (!h) return undefined;
        return sized(9 + h[8]!);
      }
      case 250: return sized(4, true); // xvp (shutdown, reboot, reset)
      case 251: { // SetDesktopSize
        const h = need(8);
        if (!h) return undefined;
        return sized(8 + 16 * h[6]!, true);
      }
      case 253: { // gii: subtype 0 injects input events
        const h = need(4);
        if (!h) return undefined;
        const length = h[1]! & 0x80 ? h.readUInt16BE(2) : h.readUInt16LE(2);
        return sized(4 + length, (h[1]! & 0x7f) === 0);
      }
      case 255: { // QEMU client messages
        const h = need(2);
        if (!h) return undefined;
        if (h[1] === 0) return sized(12, true); // extended key event
        if (h[1] === 1) { // audio
          const a = need(4);
          if (!a) return undefined;
          return sized(a.readUInt16BE(2) === 2 ? 10 : 4);
        }
        return null;
      }
      default:
        return null;
    }
  }
}
