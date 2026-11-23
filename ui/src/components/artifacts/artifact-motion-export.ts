import { drawMotionFrame, sceneOffsets, type MotionProject } from "./artifact-motion-model";

export async function exportMotion(
  project: MotionProject,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
): Promise<{ blob: Blob; extension: "mp4" | "webm" }> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(project.width / 2) * 2;
  canvas.height = Math.ceil(project.height / 2) * 2;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("A canvas is required to export this animation.");
  ctx.scale(canvas.width / project.width, canvas.height / project.height);
  const offsets = sceneOffsets(project);
  const duration = offsets[offsets.length - 1];
  const draw = (time: number) => drawMotionFrame(ctx, project, offsets, time);
  const frameRate = 30;
  // Keep downloadable, in-memory exports bounded on lower-memory browsers.
  if (duration > 180) throw new Error("Video export supports up to three minutes. Shorten the animation and try again.");
  signal.throwIfAborted();

  if (typeof VideoEncoder === "undefined") return recordCanvas(canvas, draw, duration, frameRate, onProgress, signal);
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat, canEncodeVideo } = await import("mediabunny");
  const bitrate = Math.round(3_000_000 * canvas.width * canvas.height / (1280 * 720));
  const settings = { width: canvas.width, height: canvas.height, bitrate, frameRate };
  const codec = await canEncodeVideo("avc", settings) ? "avc" : await canEncodeVideo("vp8", settings) ? "vp8" : null;
  if (!codec) return recordCanvas(canvas, draw, duration, frameRate, onProgress, signal);
  const mp4 = codec === "avc";
  const target = new BufferTarget();
  const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target });
  const track = new CanvasSource(canvas, { codec, bitrate });
  output.addVideoTrack(track, { frameRate });
  try {
    await output.start();
    const frames = Math.ceil(duration * frameRate);
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted();
      const time = frame / frameRate;
      draw(time);
      await track.add(time, Math.min(1 / frameRate, duration - time));
      if (frame % 15 === 0) onProgress((frame + 1) / frames);
    }
    track.close();
    await output.finalize();
    signal.throwIfAborted();
    if (!target.buffer) throw new Error("The video encoder returned an empty file.");
    return { blob: new Blob([target.buffer], { type: mp4 ? "video/mp4" : "video/webm" }), extension: mp4 ? "mp4" : "webm" };
  } catch (error) {
    if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => undefined);
    throw error;
  }
}

async function recordCanvas(
  canvas: HTMLCanvasElement,
  draw: (time: number) => void,
  duration: number,
  frameRate: number,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
): Promise<{ blob: Blob; extension: "mp4" | "webm" }> {
  const mimeType = typeof MediaRecorder === "undefined" ? undefined : ["video/mp4;codecs=avc1", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType || !canvas.captureStream) throw new Error("This browser does not support video export.");
  signal.throwIfAborted();
  draw(0);
  const stream = canvas.captureStream(frameRate);
  try {
    const recorder = new MediaRecorder(stream, { mimeType });
    const blob = await new Promise<Blob>((resolve, reject) => {
      const chunks: Blob[] = [];
      let timer = 0;
      const abort = () => {
        if (recorder.state !== "inactive") recorder.stop();
      };
      const cleanup = () => {
        window.clearInterval(timer);
        signal.removeEventListener("abort", abort);
      };
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { cleanup(); reject(new Error("The browser could not record this animation.")); };
      recorder.onstop = () => {
        cleanup();
        if (signal.aborted) reject(signal.reason);
        else resolve(new Blob(chunks, { type: mimeType }));
      };
      recorder.start();
      const started = performance.now();
      signal.addEventListener("abort", abort, { once: true });
      timer = window.setInterval(() => {
        const time = (performance.now() - started) / 1000;
        draw(Math.min(time, duration));
        onProgress(Math.min(time / duration, 1));
        if (time >= duration) recorder.stop();
      }, 1000 / frameRate);
    });
    if (!blob.size) throw new Error("The video recorder returned an empty file.");
    return { blob, extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm" };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
