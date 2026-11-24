// UI for the in-browser video cropper. Same interface as the Python version (index.html one
// folder up); all video work is done by engine.js on this machine.
import * as E from './engine.js';

const $ = id => document.getElementById(id);
const img = $('img'), box = $('box'), stage = $('stage');
let W = 0, H = 0, r = {x:0, y:0, w:0, h:0};   // r in (rotated) source pixels
let vid = null, srcFile = null, srcHandle = null, rot = 0;   // rot = quarter turns CW (0-3)
let job = null;                                               // running conversion
const FS = 'showOpenFilePicker' in window;                   // Chrome/Edge file-system access

const cursors = {nw:'nwse',se:'nwse',ne:'nesw',sw:'nesw',n:'ns',s:'ns',e:'ew',w:'ew'};
for (const k of ['n','e','s','w']) {          // whole-side grab strips
  const d = document.createElement('div'); d.className = 'edge ' + k; d.dataset.h = k;
  d.style.cursor = cursors[k] + '-resize'; box.appendChild(d);
}
for (const k of ['nw','ne','se','sw']) {      // corner handles
  const d = document.createElement('div'); d.className = 'hd'; d.dataset.h = k;
  d.style.cursor = cursors[k] + '-resize';
  d.style.left = k.includes('w') ? '0' : '100%';
  d.style.top  = k.includes('n') ? '0' : '100%';
  box.appendChild(d);
}

function msg(t, err) { $('msg').textContent = t; $('msg').className = err ? 'err' : ''; }
const scale = () => img.clientWidth / W;

function clamp() {
  r.w = Math.max(2, Math.min(Math.round(r.w), W));
  r.h = Math.max(2, Math.min(Math.round(r.h), H));
  r.x = Math.max(0, Math.min(Math.round(r.x), W - r.w));
  r.y = Math.max(0, Math.min(Math.round(r.y), H - r.h));
}
function draw() {
  clamp();
  const s = scale();
  const g = {left:r.x*s+'px', top:r.y*s+'px', width:r.w*s+'px', height:r.h*s+'px'};
  Object.assign(box.style, g); Object.assign($('shade').style, g);
  for (const k of 'xywh') if (document.activeElement !== $(k)) $(k).value = r[k];
  const o = outSize();
  for (const k of ['ow','oh']) if (document.activeElement !== $(k)) $(k).value = o[k];
  $('opct').textContent = `(${(o.ow * o.oh / 1e6).toFixed(2)} MP, ${Math.round(f * 100)}%)`;
  $('dims').textContent = `source ${W}×${H} → crop=${r.w}:${r.h}:${r.x}:${r.y}`;
}
// output pixel size: uniform scale factor f (≤ 1, only shrinking) applied to the crop
let f = 1;
const ev = v => Math.max(2, Math.floor(v / 2) * 2);   // even numbers, for H.264
function outSize() { return {ow: ev(r.w * f), oh: ev(r.h * f)}; }
$('ow').addEventListener('input', () => { f = Math.min(1, Math.max(0.001, (+$('ow').value || 2) / r.w)); draw(); });
$('oh').addEventListener('input', () => { f = Math.min(1, Math.max(0.001, (+$('oh').value || 2) / r.h)); draw(); });
for (const k of ['ow','oh']) $(k).addEventListener('change', () => draw());   // tidy the box on commit
$('ofull').onclick = () => { f = 1; draw(); };
for (const k of 'xywh') $(k).addEventListener('input', () => { r[k] = +$(k).value || 0; draw(); });

// zoom: null = fit to window (default); otherwise a fixed scale factor
let zoom = null;
function fitZoom() {
  const top = stage.getBoundingClientRect().top;
  const aw = document.documentElement.clientWidth - 24, ah = innerHeight - top - 12;
  return Math.max(0.02, Math.min(1, aw / W, ah / H));
}
function applyZoom() {
  if (!W) return;
  const z = zoom ?? fitZoom();
  img.style.width = W * z + 'px'; img.style.height = H * z + 'px';
  $('zl').textContent = Math.round(z * 100) + '%' + (zoom == null ? ' (fit)' : '');
  draw();
}
const curZ = () => zoom ?? fitZoom();
$('zout').onclick = () => { zoom = Math.max(0.02, curZ() / 1.25); applyZoom(); };
$('zin').onclick  = () => { zoom = Math.min(8, curZ() * 1.25); applyZoom(); };
$('zfit').onclick = () => { zoom = null; applyZoom(); };
window.addEventListener('resize', () => W && applyZoom());

// dragging: move box, resize via handles, or draw a new box on empty area
let drag = null;
stage.addEventListener('pointerdown', e => {
  if (!W) return;
  const s = scale(), b = img.getBoundingClientRect();
  const px = (e.clientX - b.left) / s, py = (e.clientY - b.top) / s;
  const h = e.target.dataset.h;
  if (h) drag = {mode:h};
  else if (e.target === box) drag = {mode:'move'};
  else { r = {x:px, y:py, w:2, h:2}; drag = {mode:'se'}; }
  drag.px = px; drag.py = py; drag.r0 = {...r};
  stage.setPointerCapture(e.pointerId); e.preventDefault();
});
stage.addEventListener('pointermove', e => {
  if (!drag) return;
  const s = scale(), b = img.getBoundingClientRect();
  const dx = (e.clientX - b.left) / s - drag.px, dy = (e.clientY - b.top) / s - drag.py;
  const o = drag.r0, m = drag.mode;
  if (m === 'move') { r.x = o.x + dx; r.y = o.y + dy; r.w = o.w; r.h = o.h; }
  else {
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (m.includes('w')) x1 = Math.min(Math.max(0, x1 + dx), x2 - 2);
    if (m.includes('e')) x2 = Math.max(Math.min(W, x2 + dx), x1 + 2);
    if (m.includes('n')) y1 = Math.min(Math.max(0, y1 + dy), y2 - 2);
    if (m.includes('s')) y2 = Math.max(Math.min(H, y2 + dy), y1 + 2);
    r = {x:x1, y:y1, w:x2 - x1, h:y2 - y1};
  }
  draw();
});
stage.addEventListener('pointerup', () => drag = null);

const setBusy = on => { for (const b of ['save','open','cw','ccw']) $(b).disabled = on || (b !== 'open' && !vid); };

async function showFrame() {   // grab the preview still for the current rotation
  const p = await E.preview(vid, rot);
  await new Promise((ok, fail) => {
    const old = img.src;
    img.onload = () => { if (old) URL.revokeObjectURL(old); ok(); };
    img.onerror = () => fail(new Error('Could not show the frame.'));
    img.src = URL.createObjectURL(p.blob);
  });
  W = img.naturalWidth; H = img.naturalHeight;
}

// ---- open ----
$('open').onclick = async () => {
  if (!FS) { $('file').value = ''; return $('file').click(); }
  try {
    const [h] = await showOpenFilePicker({ id: 'vcrop-open', types: [{ description: 'Video',
      accept: { 'video/mp4': ['.mp4', '.m4v'], 'video/quicktime': ['.mov'] } }] });
    load(await h.getFile(), h);
  } catch (e) { if (e.name !== 'AbortError') msg(e.message, true); }
};
$('file').onchange = () => { const f0 = $('file').files[0]; if (f0) load(f0, null); };

async function load(file, handle) {
  msg(''); document.title = 'Video Cropper';
  $('prog').removeAttribute('value'); status('busy', `Loading ${file.name}…`);
  setBusy(true);
  const prev = {vid, srcFile, srcHandle, rot, W, H};
  try {
    vid = await E.open(file); srcFile = file; srcHandle = handle; rot = 0;
    await showFrame();
  } catch (e) {
    ({vid, srcFile, srcHandle, rot, W, H} = prev);
    status(''); setBusy(false);
    return msg(e.message, true);
  }
  status(''); setBusy(false);
  stage.hidden = false; $('rot').textContent = '';
  r = {x:200, y:0, w:W - 400, h:H};   // default: crop=iw-400:ih, centred
  if (r.w < 2) r = {x:0, y:0, w:W, h:H};
  f = 1; zoom = null; applyZoom(); msg(file.name);
}

// ---- rotate ----
async function rotate(turn) {   // turn: 1 = CW, -1 = CCW
  const W0 = W, H0 = H;
  rot = (rot + turn + 4) % 4;
  try { await showFrame(); } catch (e) { rot = (rot - turn + 4) % 4; return msg(e.message, true); }
  // map the crop box onto the rotated frame so it stays on the same content
  r = turn > 0 ? {x: H0 - r.y - r.h, y: r.x, w: r.h, h: r.w}
               : {x: r.y, y: W0 - r.x - r.w, w: r.h, h: r.w};
  applyZoom();
  $('rot').textContent = rot ? `rotated ${rot * 90}° CW` : '';
}
$('cw').onclick = () => rotate(1);
$('ccw').onclick = () => rotate(-1);

// ---- save ----
$('save').onclick = async () => {
  clamp(); msg('');
  const mov = /\.mov$/i.test(srcFile.name);
  const ext = mov ? '.mov' : '.mp4';
  const name = srcFile.name.replace(/\.[^.]*$/, '') + '_crop' + ext;
  let handle = null, writable = null;
  setBusy(true);
  try {
    if (FS) {
      status('busy', 'Choose where to save…');
      try {
        handle = await showSaveFilePicker({ suggestedName: name, id: 'vcrop-save',
          ...(srcHandle ? { startIn: srcHandle } : {}),   // default: folder of the opened video
          types: [{ description: 'Video', accept: { [mov ? 'video/quicktime' : 'video/mp4']: [ext] } }] });
      } catch (e) { if (e.name === 'AbortError') return status(''); throw e; }
      if (srcHandle && await handle.isSameEntry(srcHandle))
        throw new Error('Refusing to overwrite the source file');
      writable = await handle.createWritable();
    }
    const crop = {x: r.x, y: r.y, w: ev(r.w), h: ev(r.h)};
    const {ow, oh} = outSize();
    $('prog').value = 0; status('busy', 'Rendering… 0%'); $('cancel').hidden = false;
    job = await E.convert(vid, { rot, crop, ow, oh, mute: $('mute').checked, mov, writable,
      onProgress: p => { $('prog').value = p; status('busy', `Rendering… ${Math.round(p * 100)}%`);
                         document.title = `${Math.round(p * 100)}% – Video Cropper`; } });
    const blob = await job.done;
    if (blob) {   // no file-system access (Safari/Firefox): hand it over as a download
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    const desc = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` + (rot ? `, rotated ${rot * 90}°` : '') +
                 ((ow !== crop.w || oh !== crop.h) ? `, scaled to ${ow}×${oh}` : '') +
                 ($('mute').checked ? ', no audio' : '');
    status('done', `✓ Saved: ${handle ? handle.name : name}   (${desc})` +
                   (job.warnings.length ? '\n⚠ ' + job.warnings.join('\n⚠ ') : ''));
    document.title = '✓ Saved – Video Cropper';
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch {} }
    if (handle && handle.remove) { try { await handle.remove(); } catch {} }   // drop partial file
    document.title = 'Video Cropper';
    if (e instanceof E.ConversionCanceledError) status('fail', 'Render cancelled.');
    else status('fail', '✗ Failed:\n' + (e && e.message || e));
  } finally {
    job = null; $('cancel').hidden = true; setBusy(false);
  }
};

$('cancel').onclick = () => { $('cancel').hidden = true; if (job) job.conversion.cancel(); };

function status(cls, text) {
  $('status').className = cls || '';
  $('stxt').textContent = text || '';
  $('stxt').style.whiteSpace = 'pre-wrap';
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
