/**
 * The live view's RFB proxy: DES and VNC Authentication against known vectors (FIPS 46 and
 * OpenSSL's legacy DES), the handshake the server completes towards the VM (a fake x11vnc
 * speaking RFB 3.8 with VNC Authentication) while the browser sees security type None, input
 * dropped for viewers and passed for the person in control, flipping on the same connection, and
 * the framing of variable-length client messages. Fakes only: no VM, no VNC server.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { ComputerConfig } from "@polpo-ai/core";
import { desEcbEncrypt, desEcbEncryptJs, desEcbEncryptNode, vncAuthResponse, vncKey } from "../sandbox/vnc-auth.js";
import { RfbProxy, type RfbFailure } from "../server/rfb-proxy.js";
import { attachComputerDesktopWebSocket } from "../server/computer-desktop-ws.js";
import type { ComputerDesktops } from "../sandbox/desktop.js";

const hex = (s: string) => Buffer.from(s, "hex");
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const CHALLENGE = hex("000102030405060708090a0b0c0d0e0f");

describe("DES and VNC Authentication", () => {
  it("DES-ECB matches the FIPS 46 vectors, pure JS and node:crypto alike", () => {
    expect(desEcbEncryptJs(hex("133457799BBCDFF1"), hex("0123456789ABCDEF")).toString("hex")).toBe("85e813540f0ab405");
    expect(desEcbEncryptJs(hex("0E329232EA6D0D73"), hex("8787878787878787")).toString("hex")).toBe("0000000000000000");
    const node = desEcbEncryptNode(hex("133457799BBCDFF1"), hex("0123456789ABCDEF"));
    if (node) expect(node.toString("hex")).toBe("85e813540f0ab405");
    expect(desEcbEncrypt(hex("133457799BBCDFF1"), hex("0123456789ABCDEF0123456789ABCDEF")).toString("hex")).toBe("85e813540f0ab40585e813540f0ab405");
  });

  it("the VNC key bit-reverses each password byte, zero-padded to 8", () => {
    expect(vncKey("password").toString("hex")).toBe("0e86ceceeef64e26");
    expect(vncKey("pw").toString("hex")).toBe("0eee000000000000");
    expect(vncKey("longer than eight").toString("hex")).toBe(vncKey("longer t").toString("hex"));
  });

  it("answers a challenge like OpenSSL's DES with the VNC key", () => {
    // openssl enc -des-ecb -provider legacy -K <vncKey> -nopad over 00..0f
    expect(vncAuthResponse("password", CHALLENGE).toString("hex")).toBe("b866924125c8eebb9debc1db61c538e2");
    expect(vncAuthResponse("pw", CHALLENGE).toString("hex")).toBe("858600d9af143c9e6541d3dd92a835d0");
    expect(() => vncAuthResponse("pw", Buffer.alloc(8))).toThrow(/16 bytes/);
  });
});

/** The VM's ServerInit: 1280x800, a pixel format, its name. */
const SERVER_INIT = Buffer.concat([Buffer.from([0x05, 0x00, 0x03, 0x20]), hex("200018000100ff00ff00ff1008000000"), u32(8), Buffer.from("polpo:99")]);

/** A proxy already through both handshakes (the VM asked VNC Authentication); what it sent each way. */
function handshaken(o: { control?: () => boolean } = {}) {
  const toServer: Buffer[] = [];
  const toClient: Buffer[] = [];
  const failures: Array<[RfbFailure, string]> = [];
  const proxy = new RfbProxy({
    password: "s3cretpw", canControl: o.control ?? (() => false),
    toServer: (b) => toServer.push(b), toClient: (b) => toClient.push(b), fail: (w, m) => failures.push([w, m]),
  });
  proxy.start();
  proxy.fromServer(Buffer.from("RFB 003.008\n"));
  proxy.fromServer(Buffer.from([1, 2]));
  proxy.fromServer(CHALLENGE);
  proxy.fromServer(u32(0));
  proxy.fromServer(SERVER_INIT);
  proxy.fromClient(Buffer.from("RFB 003.008\n"));
  proxy.fromClient(Buffer.from([1])); // None
  proxy.fromClient(Buffer.from([1])); // ClientInit
  const sent = () => Buffer.concat(toServer.splice(0));
  // the VM got: its version, type 2, the DES answer, ClientInit shared
  expect(sent()).toEqual(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([2]), vncAuthResponse("s3cretpw", CHALLENGE), Buffer.from([1])]));
  // the viewer got: 3.8, [None], OK, the VM's ServerInit
  expect(Buffer.concat(toClient.splice(0))).toEqual(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1]), u32(0), SERVER_INIT]));
  return { proxy, sent, toClient, failures };
}

const KEY = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]); // Enter down
const POINTER = Buffer.from([5, 1, 0, 10, 0, 20]);
const FBUR = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 0x20]);
const setEncodings = (encs: number[]) => {
  const b = Buffer.alloc(4 + 4 * encs.length);
  b[0] = 2; b.writeUInt16BE(encs.length, 2);
  encs.forEach((e, i) => b.writeInt32BE(e, 4 + 4 * i));
  return b;
};
const cutText = (text: string) => Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(text.length), Buffer.from(text)]);
const extendedCut = (flags: number, payload: Buffer) => {
  const b = Buffer.alloc(8);
  b[0] = 6; b.writeInt32BE(-(4 + payload.length), 4);
  return Buffer.concat([b, u32(flags), payload]);
};

describe("the RFB proxy", () => {
  it("frames variable-length messages split anywhere, passing the non-input ones untouched", () => {
    const { proxy, sent } = handshaken();
    const enc = setEncodings([7, 16, 0, -239, -223, -26, -254]);
    const stream = Buffer.concat([enc, FBUR, Buffer.from([0, 0, 0, 0]), hex("200018000100ff00ff00ff1008000000")]);
    for (const byte of stream) proxy.fromClient(Buffer.from([byte])); // one byte at a time
    expect(sent()).toEqual(stream);
    // a fence with its payload, continuous updates
    const fence = Buffer.concat([Buffer.from([248, 0, 0, 0]), u32(0x80000000), Buffer.from([3, 9, 9, 9])]);
    const cont = Buffer.from([150, 1, 0, 0, 0, 0, 5, 0, 3, 0x20]);
    proxy.fromClient(Buffer.concat([fence, cont]));
    expect(sent()).toEqual(Buffer.concat([fence, cont]));
  });

  it("drops a viewer's input (keys, pointer, clipboard, QEMU keys, desktop size) and keeps the framing", () => {
    const { proxy, sent } = handshaken();
    const qemuKey = Buffer.from([255, 0, 0, 1, 0, 0, 0xff, 0x0d, 0, 0, 0, 0x1c]);
    const desktopSize = Buffer.concat([Buffer.from([251, 0, 5, 0, 3, 0x20, 1, 0]), Buffer.alloc(16)]);
    proxy.fromClient(Buffer.concat([KEY, POINTER, cutText("hunter2"), qemuKey, desktopSize, FBUR]));
    expect(sent()).toEqual(FBUR);
    expect(proxy.stats).toMatchObject({ dropped: 5, passed: 1 });
  });

  it("extended clipboard: capabilities pass for everyone, data only for the person in control", () => {
    let control = false;
    const { proxy, sent } = handshaken({ control: () => control });
    const caps = extendedCut((1 << 24) | 1, u32(0));
    const provide = extendedCut((1 << 28) | 1, Buffer.from("zlibdata"));
    proxy.fromClient(Buffer.concat([caps, provide, FBUR]));
    expect(sent()).toEqual(Buffer.concat([caps, FBUR]));
    control = true;
    proxy.fromClient(provide);
    expect(sent()).toEqual(provide);
  });

  it("an extended PointerEvent (7 bytes) once the viewer asked for extended mouse buttons", () => {
    const { proxy, sent } = handshaken({ control: () => true });
    const enc = setEncodings([7, -316]);
    const extended = Buffer.from([5, 0x81, 0, 10, 0, 20, 1]);
    proxy.fromClient(Buffer.concat([enc, extended, POINTER]));
    expect(sent()).toEqual(Buffer.concat([enc, extended, POINTER]));
  });

  it("a message it cannot frame closes the connection; a viewer offered None cannot pick another", () => {
    const { proxy, failures } = handshaken();
    proxy.fromClient(Buffer.from([99, 1, 2, 3]));
    expect(failures).toEqual([["protocol", expect.stringMatching(/does not know/)]]);
    const f2: RfbFailure[] = [];
    const p2 = new RfbProxy({ password: "x", canControl: () => true, toServer: () => {}, toClient: () => {}, fail: (w) => f2.push(w) });
    p2.start();
    p2.fromClient(Buffer.from("RFB 003.008\n"));
    p2.fromClient(Buffer.from([2]));
    expect(f2).toEqual(["protocol"]);
  });

  it("an RFB 3.3 viewer gets security type None directly; client messages wait for the VM's handshake", () => {
    const toServer: Buffer[] = [];
    const toClient: Buffer[] = [];
    const p = new RfbProxy({ password: "pw", canControl: () => false, toServer: (b) => toServer.push(b), toClient: (b) => toClient.push(b), fail: () => {} });
    p.start();
    p.fromClient(Buffer.from("RFB 003.003\n"));
    expect(toClient.at(-1)).toEqual(u32(1));
    p.fromClient(Buffer.concat([Buffer.from([0]), FBUR])); // ClientInit, then a request before the VM is ready
    expect(toServer).toEqual([]);
    p.fromServer(Buffer.from("RFB 003.007\n"));
    p.fromServer(Buffer.from([2, 1, 2]));
    p.fromServer(CHALLENGE);
    p.fromServer(u32(0));
    p.fromServer(SERVER_INIT);
    expect(Buffer.concat(toServer)).toEqual(Buffer.concat([Buffer.from("RFB 003.007\n"), Buffer.from([2]), vncAuthResponse("pw", CHALLENGE), Buffer.from([1]), FBUR]));
    expect(toClient.at(-1)).toEqual(SERVER_INIT);
  });

  it("a refused password fails as auth, with the VM's reason", () => {
    const failures: Array<[RfbFailure, string]> = [];
    const p = new RfbProxy({ password: "pw", canControl: () => false, toServer: () => {}, toClient: () => {}, fail: (w, m) => failures.push([w, m]) });
    p.fromServer(Buffer.from("RFB 003.008\n"));
    p.fromServer(Buffer.from([1, 2]));
    p.fromServer(CHALLENGE);
    p.fromServer(Buffer.concat([u32(1), u32(15), Buffer.from("password check failed!")]));
    expect(failures).toEqual([["auth", expect.stringMatching(/refused the password: password check/)]]);
  });
});

// ── end to end: browser WebSocket → Polpo → a fake x11vnc behind websockify ──

/** Bytes from a socket, read in exact amounts. */
function reader(ws: WebSocket) {
  let buf = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  ws.on("message", (m: Buffer) => { buf = Buffer.concat([buf, m]); wake?.(); });
  return {
    async read(n: number): Promise<Buffer> {
      while (buf.length < n) await new Promise<void>((r) => { wake = r; });
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    get pending() { return buf.length; },
  };
}

const NINA: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona" };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(undefined)); })));
});
const listen = async (s: Server) => { servers.push(s); await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r())); return (s.address() as { port: number }).port; };

/** A VNC server like x11vnc: RFB 3.8, VNC Authentication with `password`; records what it gets after ServerInit. */
async function fakeVm(password: string) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const vm = { received: Buffer.alloc(0), authed: false, shared: -1, wait: async (n: number) => { while (vm.received.length < n) await new Promise((r) => setTimeout(r, 5)); } };
  wss.on("connection", (s) => {
    const r = reader(s);
    void (async () => {
      s.send(Buffer.from("RFB 003.008\n"));
      await r.read(12);
      s.send(Buffer.from([1, 2]));
      expect((await r.read(1))[0]).toBe(2);
      s.send(CHALLENGE);
      const answer = await r.read(16);
      vm.authed = answer.equals(vncAuthResponse(password, CHALLENGE));
      if (!vm.authed) { s.send(Buffer.concat([u32(1), u32(21), Buffer.from("password check failed")])); s.close(); return; }
      s.send(u32(0));
      vm.shared = (await r.read(1))[0]!;
      s.send(SERVER_INIT);
      for (;;) vm.received = Buffer.concat([vm.received, await r.read(1)]);
    })().catch(() => {});
  });
  return { vm, port: await listen(http) };
}

async function bridge(o: { password: string; vmPassword: string }) {
  const { vm, port: vmPort } = await fakeVm(o.vmPassword);
  let holder: string | undefined;
  const invalidated: string[] = [];
  const desktops = {
    attached: async () => true,
    password: () => o.password,
    endpoint: async () => ({ url: `ws://127.0.0.1:${vmPort}/`, headers: {} }),
    hold: () => () => {},
    invalidate: (id: string) => invalidated.push(id),
  } as unknown as ComputerDesktops;
  const http = createServer();
  const ws = attachComputerDesktopWebSocket(http, {
    authorize: () => true, ready: () => true, computer: (id) => (id === "nina" ? NINA : undefined), desktops: () => desktops,
    person: (req) => (req.headers["x-test-person"] as string | undefined), holder: () => holder,
  });
  const port = await listen(http);
  const browser = (person: string) => {
    const c = new WebSocket(`ws://127.0.0.1:${port}/api/v1/computers/nina/desktop/vnc`, { headers: { "x-test-person": person } });
    return { c, r: reader(c), opened: new Promise((res, rej) => { c.on("open", res); c.on("error", rej); }) };
  };
  return { vm, browser, invalidated, setHolder: (p: string | undefined) => { holder = p; ws.controlChanged("nina"); } };
}

/** The viewer's side of the handshake: 3.8, None, shared; returns the ServerInit it got. */
async function viewerHandshake(b: { c: WebSocket; r: ReturnType<typeof reader> }) {
  expect((await b.r.read(12)).toString()).toBe("RFB 003.008\n");
  b.c.send(Buffer.from("RFB 003.008\n"));
  expect(await b.r.read(2)).toEqual(Buffer.from([1, 1])); // only None: no password asked
  b.c.send(Buffer.from([1]));
  expect(await b.r.read(4)).toEqual(u32(0));
  b.c.send(Buffer.from([0])); // not shared: the VM connection is shared anyway
  return b.r.read(SERVER_INIT.length);
}

describe("the live view WebSocket", () => {
  it("authenticates to the VM itself, hands the browser the VM's ServerInit, and flips control without reconnecting", async () => {
    const t = await bridge({ password: "s3cretpw", vmPassword: "s3cretpw" });
    const ale = t.browser("ale@x.it");
    await ale.opened;
    expect(await viewerHandshake(ale)).toEqual(SERVER_INIT);
    expect(t.vm.authed).toBe(true);
    expect(t.vm.shared).toBe(1);
    // watching: input dropped, the update request passes
    ale.c.send(Buffer.concat([KEY, POINTER]));
    ale.c.send(FBUR);
    await t.vm.wait(FBUR.length);
    expect(t.vm.received).toEqual(FBUR);
    // ale takes control: the same connection, input passes
    t.setHolder("ale@x.it");
    ale.c.send(KEY);
    await t.vm.wait(FBUR.length + KEY.length);
    expect(t.vm.received.subarray(FBUR.length)).toEqual(KEY);
    // another person holds it now: ale's input is dropped again
    t.setHolder("bob@x.it");
    ale.c.send(POINTER);
    ale.c.send(FBUR);
    await t.vm.wait(2 * FBUR.length + KEY.length);
    expect(t.vm.received.subarray(FBUR.length + KEY.length)).toEqual(FBUR);
    // the VM's updates reach the viewer as they are
    expect(ale.c.readyState).toBe(WebSocket.OPEN);
    ale.c.close();
  });

  it("a password the VM refuses closes the viewer and forgets it (the next start sets a new one)", async () => {
    const t = await bridge({ password: "stale", vmPassword: "s3cretpw" });
    const b = t.browser("ale@x.it");
    await b.opened;
    const closed = new Promise<number>((r) => b.c.on("close", (code) => r(code)));
    void viewerHandshake(b).catch(() => undefined); // never completes: no ServerInit comes
    expect(await closed).toBe(1011);
    expect(t.vm.authed).toBe(false);
    expect(t.invalidated).toEqual(["nina"]);
  });
});
