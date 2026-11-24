// Video engine: everything runs in the browser (WebCodecs via Mediabunny). No server work.
import {
  Input, Output, Conversion, BlobSource, BufferTarget, StreamTarget, CanvasSink,
  Mp4OutputFormat, MovOutputFormat, ALL_FORMATS, QUALITY_VERY_HIGH, ConversionCanceledError,
} from './vendor/mediabunny-1.65.2.min.mjs';

export { ConversionCanceledError };

/** Open a video File/Blob. Returns a handle used by preview() and convert(). */
export async function open(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found in this file.');
  if (!(await track.canDecode()))
    throw new Error(`This browser can't decode the video codec (${track.codec || 'unknown'}).`);
  const start = await track.getFirstTimestamp();
  const dur = await input.computeDuration();
  return { input, track, start, dur };
}

/** A still frame (≈1 s in, like the Python version) with `rot` extra quarter turns clockwise.
 *  Returns {blob, width, height} in display pixels after rotation. */
export async function preview(v, rot = 0) {
  const rotation = (v.track.rotation + 90 * rot) % 360;
  const sink = new CanvasSink(v.track, { rotation });
  const t = v.start + Math.min(1, Math.max(0, (v.dur - v.start) / 2));
  const fr = (await sink.getCanvas(t)) || (await sink.getCanvas(v.start));
  if (!fr) throw new Error('Could not read a frame from this video.');
  const c = fr.canvas;
  const blob = c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
                               : await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.92));
  return { blob, width: c.width, height: c.height };
}

/** Crop/rotate/scale/mute into `writable` (a FileSystemWritableFileStream), or into memory
 *  when writable is null (returns a Blob). crop and out sizes must be even (H.264).
 *  onProgress(0..1); returns {conversion, done: Promise<Blob|null>} so the caller can cancel. */
export async function convert(v, { rot = 0, crop, ow, oh, mute = false, mov = false, writable = null, onProgress }) {
  const target = writable ? new StreamTarget(writable) : new BufferTarget();
  const output = new Output({ format: mov ? new MovOutputFormat() : new Mp4OutputFormat(), target });
  const conversion = await Conversion.init({
    input: v.input, output,
    video: {
      rotate: (90 * rot) % 360,               // added to the file's own rotation metadata
      crop: { left: crop.x, top: crop.y, width: crop.w, height: crop.h },   // after rotation
      width: ow, height: oh, fit: 'fill',
      codec: 'avc', quality: QUALITY_VERY_HIGH,
      allowTransformationMetadata: false,      // bake rotation into the pixels, like ffmpeg did
      forceTranscode: true,
    },
    audio: mute ? { discard: true } : {},
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks
      .filter(d => d.track.type === 'video' || !mute)
      .map(d => `${d.track.type} track: ${d.reason.replace(/_/g, ' ')}`).join('\n');
    throw new Error('Cannot convert this file:\n' + why);
  }
  conversion.onProgress = p => onProgress && onProgress(p);
  // tracks dropped for reasons other than "Remove sound" (e.g. an audio codec it can't handle)
  const warnings = conversion.discardedTracks.filter(d => d.reason !== 'discarded_by_user')
    .map(d => `${d.track.type} track dropped: ${d.reason.replace(/_/g, ' ')}`);
  const done = conversion.execute().then(() =>
    writable ? null : new Blob([target.buffer], { type: mov ? 'video/quicktime' : 'video/mp4' }));
  return { conversion, done, warnings };
}
