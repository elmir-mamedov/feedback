import { IMAGE_TYPES } from "../protocol.ts";

/**
 * Screenshots as a report carries them: shrunk in the browser so a Retina
 * screenshot fits the limits, and captured from the tab where the browser
 * allows it.
 */

const MAX_EDGE = 2400;
const KEEP_AS_IS: readonly string[] = Object.keys(IMAGE_TYPES);

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * The image as it will be sent: as it is when it's already small and of a
 * type a report takes, else shrunk to 2400px on its long edge and re-encoded
 * as WebP, or JPEG where the browser can't encode WebP (Safari).
 */
export async function prepareImage(blob: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("That file isn't an image this browser can read.");
  }
  const edge = Math.max(bitmap.width, bitmap.height);
  if (KEEP_AS_IS.includes(blob.type) && blob.size <= 1024 * 1024 && edge <= MAX_EDGE) {
    bitmap.close();
    return blob;
  }
  const scale = Math.min(1, MAX_EDGE / edge);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const webp = await toBlob(canvas, "image/webp", 0.92);
  if (webp && webp.type === "image/webp") return webp;
  const jpeg = await toBlob(canvas, "image/jpeg", 0.9);
  if (!jpeg) throw new Error("That image couldn't be prepared.");
  return jpeg;
}

/** Whether this browser can capture a tab: desktop browsers, not phones. */
export function canCaptureTab(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

/**
 * One frame of the current tab, as a PNG; null when the person chooses not
 * to share. The caller hides its dialog first, so it isn't in the shot.
 */
export async function captureTab(): Promise<Blob | null> {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
    } as DisplayMediaStreamOptions);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 300)); // a fresh frame, without the dialog
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    return await toBlob(canvas, "image/png");
  } catch (error) {
    // NotAllowedError is the person choosing not to share: nothing to say.
    if (error instanceof DOMException && error.name === "NotAllowedError") return null;
    throw error;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
