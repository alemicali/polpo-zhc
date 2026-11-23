import { nanoid } from "nanoid";
import type { SlideElement } from "./artifact-slides-format";

export const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm"]);
export const videoFileExtension = (src: string) => src.startsWith("data:video/webm;") ? "webm" : "mp4";

const readData = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener("load", () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The video could not be read.")), { once: true });
  reader.addEventListener("error", () => reject(new Error("The video could not be read.")), { once: true });
  reader.readAsDataURL(file);
});

function videoFrame(file: File) {
  return new Promise<Pick<SlideElement, "w" | "h" | "poster">>((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    function cleanUp() {
      clearTimeout(timeout);
      video.removeEventListener("error", failed);
      video.removeEventListener("loadeddata", loaded);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
    function failed() {
      cleanUp();
      reject(new Error("Your browser could not open this video's codec."));
    }
    function loaded() {
      if (!video.videoWidth || !video.videoHeight) { failed(); return; }
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      context?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const ratio = (video.videoHeight / video.videoWidth) * (16 / 9);
      const w = Math.min(52, 54 / ratio);
      const poster = context ? canvas.toDataURL("image/png") : undefined;
      cleanUp();
      resolve({ w, h: w * ratio, poster });
    }
    const timeout = window.setTimeout(failed, 10000);
    video.addEventListener("error", failed, { once: true });
    video.addEventListener("loadeddata", loaded, { once: true });
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
  });
}

export function linkedVideo(src: string, alt: string): SlideElement {
  return { id: nanoid(), type: "video", x: 24, y: 32, w: 52, h: 52, src, alt };
}

export async function embeddedVideo(file: File, availableBytes: number): Promise<SlideElement> {
  if (!VIDEO_MIME_TYPES.has(file.type)) throw new Error("Choose an MP4 or WebM video.");
  if (4 * Math.ceil(file.size / 3) > availableBytes) {
    throw new Error("This video exceeds the space left in the deck. Insert an HTTPS video link instead.");
  }
  const [src, { w, h, poster }] = await Promise.all([readData(file), videoFrame(file)]);
  return {
    id: nanoid(), type: "video", x: (100 - w) / 2, y: (100 - h) / 2, w, h, src,
    poster: src.length + (poster?.length ?? 0) <= availableBytes ? poster : undefined,
    alt: file.name.replace(/\.[^.]+$/, ""),
  };
}

export async function powerPointVideoCover(poster?: string): Promise<string | undefined> {
  if (!poster || poster.startsWith("data:image/png;")) return poster;
  const image = new Image();
  image.src = poster;
  try { await image.decode(); } catch { return undefined; }
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
