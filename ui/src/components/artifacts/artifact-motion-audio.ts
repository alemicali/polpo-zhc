import { MAX_MOTION_AUDIO_BYTES, motionAudioMime, type MotionAudio } from "./artifact-motion-model";

export async function loadMotionAudio(file: File): Promise<MotionAudio> {
  const mime = motionAudioMime(file);
  if (!mime) throw new Error("Choose an MP3, WAV, AAC, FLAC, Ogg or WebM audio file.");
  if (!file.size || file.size > MAX_MOTION_AUDIO_BYTES) throw new Error("Choose an audio file under 700 KB.");
  const blob = file.slice(0, file.size, mime);
  const url = URL.createObjectURL(blob);
  try {
    const metadata = new Audio();
    const duration = await new Promise<number>((resolve, reject) => {
      metadata.onloadedmetadata = () => resolve(metadata.duration);
      metadata.onerror = () => reject(new Error("This audio file could not be read by your browser."));
      metadata.preload = "metadata";
      metadata.src = url;
    });
    if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error("Choose a soundtrack up to three minutes long.");
  } finally {
    URL.revokeObjectURL(url);
  }
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The soundtrack could not be read."));
    reader.onerror = () => reject(new Error("The soundtrack could not be read."));
    reader.readAsDataURL(blob);
  });
  return { name: file.name, src };
}

export async function prepareMotionAudio(audio: MotionAudio | undefined, duration: number, signal: AbortSignal): Promise<AudioBuffer | undefined> {
  if (!audio || (audio.delay ?? 0) >= duration) return undefined;
  signal.throwIfAborted();
  const encoded = audio.src.slice(audio.src.indexOf(",") + 1);
  const data = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)).buffer;
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(2, 1, sampleRate);
  const decoded = await context.decodeAudioData(data);
  signal.throwIfAborted();
  const silence = Math.round((audio.delay ?? 0) * sampleRate);
  const maxSamples = Math.floor(duration * sampleRate);
  const samples = Math.min(maxSamples - silence, decoded.length);
  if (samples <= 0) return undefined;
  const channels = Math.min(2, decoded.numberOfChannels);
  const mixed = context.createBuffer(channels, silence + samples, sampleRate);
  for (let i = 0; i < channels; i++) mixed.copyToChannel(decoded.getChannelData(i).subarray(0, samples), i, silence);
  return mixed;
}
