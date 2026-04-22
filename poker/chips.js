/* ════════════════════════════════════════════════════════════════════
   CHIPS.JS — Photo-based poker chip counter (YOLO-seg ONNX model)
   ════════════════════════════════════════════════════════════════════
   Pipeline on a user-uploaded photo:
     1. Fit image into a work canvas (max dim WORK_MAX_DIM)
     2. Letterbox into 640×640 and run the YOLO-seg ONNX model
     3. Decode detections, NMS, reconstruct per-chip segmentation masks
     4. Sample median color of each chip under its mask
     5. Agglomerative-cluster samples in Lab space, match each cluster
        to a canonical chip color → default denomination
     6. Tint detected pixels on the overlay canvas, render group rows

   The model outputs the standard Ultralytics YOLO-seg tensor shapes:
     output0: [1, 4+nc+32, N]     — box + class scores + mask coeffs
     output1: [1, 32, mh, mw]     — mask prototypes
   ════════════════════════════════════════════════════════════════════ */


/* ── Model config ─────────────────────────────────────────────────── */
const MODEL_URL = 'model.onnx';
const INPUT_SIZE = 640;
const SCORE_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;
const MASK_THRESHOLD = 0.5;
const NUM_CLASSES = 1;
const NUM_MASK_COEFFS = 32;


/* ── Canonical chip colors (typical US cash game) ─────────────────── */
const CANONICAL_CHIPS = [
  { name: 'Red', rgb: [130, 40, 40], denom: 5 },
  { name: 'Blue', rgb: [40, 80, 180], denom: 10 },
  { name: 'Green', rgb: [40, 140, 60], denom: 25 },
  { name: 'Black', rgb: [30, 30, 30], denom: 100 },
  { name: 'Purple', rgb: [110, 50, 150], denom: 500 },
];

/* Precompute Lab for canonical colors — used by nearestCanonical(). */
CANONICAL_CHIPS.forEach(c => { c.lab = rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]); });


/* ── Detection params ─────────────────────────────────────────────── */
const WORK_MAX_DIM = 1200;
const CLUSTER_DE_THRESHOLD = 22;   // ΔE76 below which two clusters merge


/* ── State ────────────────────────────────────────────────────────── */
const state = {
  session: null,
  loadingSession: null,             // in-flight load promise
  imageBitmap: null,                // source image
  workW: 0,
  workH: 0,
  detections: [],                  // [{ x, y, r, rgb, lab, mask }]
  groups: [],
  nextGroupId: 1,
};


/* ── Model load ───────────────────────────────────────────────────── */
function loadSession() {
  if (state.session) return Promise.resolve(state.session);
  if (state.loadingSession) return state.loadingSession;
  state.loadingSession = ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ['webgpu', 'wasm'],
  }).then((s) => { state.session = s; return s; });
  return state.loadingSession;
}


/* ── Color math ───────────────────────────────────────────────────── */
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  let X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.00000;
  let Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDist(a, b) {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}


/* ── Image load ───────────────────────────────────────────────────── */
function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      state.imageBitmap = img;
      drawImageToCanvas(img);
      showPreview();
      runDetection();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function drawImageToCanvas(img) {
  const canvas = document.getElementById('previewCanvas');
  const ctx = canvas.getContext('2d');
  const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = maxDim > WORK_MAX_DIM ? WORK_MAX_DIM / maxDim : 1;
  state.workW = Math.round(img.naturalWidth * scale);
  state.workH = Math.round(img.naturalHeight * scale);
  canvas.width = state.workW;
  canvas.height = state.workH;
  ctx.drawImage(img, 0, 0, state.workW, state.workH);
}


/* ── Detection ────────────────────────────────────────────────────── */
async function runDetection() {
  try {
    if (!state.session) setStatus('Loading model…');
    const session = await loadSession();
    setStatus('Detecting chips…');
    // Yield so the status text actually paints before we block on inference.
    await new Promise(r => setTimeout(r, 20));

    const detections = await detectChips(session);
    state.detections = detections;

    if (detections.length === 0) {
      state.groups = [];
      renderGroups();
      renderOverlay();
      setStatus('No chips detected — try another photo');
      showResults();
      return;
    }

    state.groups = clusterIntoGroups(detections);
    renderGroups();
    renderOverlay();
    setStatus('');
    showResults();
  } catch (err) {
    console.error(err);
    setStatus('Detection failed: ' + err.message);
  }
}

async function detectChips(session) {
  const canvas = document.getElementById('previewCanvas');
  const ctx = canvas.getContext('2d');
  const targetW = canvas.width, targetH = canvas.height;

  const { tensor, scale, padX, padY } = letterbox(canvas, INPUT_SIZE);
  const feeds = { [session.inputNames[0]]: tensor };
  const results = await session.run(feeds);
  const out0 = results[session.outputNames[0]]; // [1, 4+nc+32, N]
  const out1 = results[session.outputNames[1]]; // [1, 32, mh, mw]

  const dets = decodeDetections(out0, SCORE_THRESHOLD);
  const kept = nms(dets, IOU_THRESHOLD);
  const protoMasks = reconstructMasks(kept, out1);

  const imgPixels = ctx.getImageData(0, 0, targetW, targetH);
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    const det = kept[i];
    const mask = rasterizeMask(
      protoMasks[i], det.box, out1.dims[3], out1.dims[2],
      scale, padX, padY, targetW, targetH
    );
    const rgb = sampleMaskColor(imgPixels, mask);
    if (!rgb) continue;

    // Map bbox from 640-space back to work-canvas space for a center/radius
    // anchor (used by the overlay center-dot).
    const [x1, y1, x2, y2] = det.box;
    const bx1 = (x1 - padX) / scale;
    const by1 = (y1 - padY) / scale;
    const bx2 = (x2 - padX) / scale;
    const by2 = (y2 - padY) / scale;
    const cx = (bx1 + bx2) / 2;
    const cy = (by1 + by2) / 2;
    const r = Math.max(bx2 - bx1, by2 - by1) / 2;

    out.push({
      x: cx, y: cy, r,
      rgb, lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
      mask,
      score: det.score,
    });
  }
  return out;
}

function letterbox(srcCanvas, size) {
  const w0 = srcCanvas.width, h0 = srcCanvas.height;
  const scale = Math.min(size / w0, size / h0);
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const padX = Math.floor((size - w) / 2);
  const padY = Math.floor((size - h) / 2);

  const off = document.createElement('canvas');
  off.width = size; off.height = size;
  const octx = off.getContext('2d');
  octx.fillStyle = 'rgb(114,114,114)';
  octx.fillRect(0, 0, size, size);
  octx.drawImage(srcCanvas, padX, padY, w, h);
  const { data } = octx.getImageData(0, 0, size, size);

  const chw = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    chw[p] = data[i] / 255;
    chw[plane + p] = data[i + 1] / 255;
    chw[2 * plane + p] = data[i + 2] / 255;
  }
  const tensor = new ort.Tensor('float32', chw, [1, 3, size, size]);
  return { tensor, scale, padX, padY };
}

function decodeDetections(output, threshold) {
  // output dims: [1, 4+nc+mc, N]. Stored as [channels, anchors] row-major.
  const [, , n] = output.dims;
  const data = output.data;
  const dets = [];
  for (let i = 0; i < n; i++) {
    let bestScore = 0, bestClass = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const s = data[(4 + c) * n + i];
      if (s > bestScore) { bestScore = s; bestClass = c; }
    }
    if (bestScore < threshold) continue;
    const cx = data[0 * n + i];
    const cy = data[1 * n + i];
    const w = data[2 * n + i];
    const h = data[3 * n + i];
    const coeffs = new Float32Array(NUM_MASK_COEFFS);
    for (let k = 0; k < NUM_MASK_COEFFS; k++) {
      coeffs[k] = data[(4 + NUM_CLASSES + k) * n + i];
    }
    dets.push({
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
      score: bestScore,
      cls: bestClass,
      coeffs,
    });
  }
  return dets;
}

function nms(dets, iouThreshold) {
  dets.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of dets) {
    if (kept.every((k) => iou(k.box, d.box) < iouThreshold)) kept.push(d);
  }
  return kept;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aArea = (a[2] - a[0]) * (a[3] - a[1]);
  const bArea = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (aArea + bArea - inter + 1e-9);
}

function reconstructMasks(dets, protoTensor) {
  // proto: [1, 32, mh, mw]. Per-det mask = sigmoid(coeffs · proto).
  const [, mc, mh, mw] = protoTensor.dims;
  const proto = protoTensor.data;
  const area = mh * mw;
  const masks = [];
  for (const d of dets) {
    const m = new Float32Array(area);
    for (let k = 0; k < mc; k++) {
      const a = d.coeffs[k];
      const off = k * area;
      for (let j = 0; j < area; j++) m[j] += a * proto[off + j];
    }
    for (let j = 0; j < area; j++) m[j] = 1 / (1 + Math.exp(-m[j]));
    masks.push(m);
  }
  return masks;
}

function rasterizeMask(mask, box, mw, mh, scale, padX, padY, targetW, targetH) {
  // Mask lives in a protos-sized grid (typically 160×160) in 640-input-space.
  // Project detection box into that grid, then resample to image pixels and
  // threshold into a binary Uint8Array the size of the work canvas.
  const [x1, y1, x2, y2] = box;
  const sx = mw / INPUT_SIZE;
  const sy = mh / INPUT_SIZE;
  const mx1 = Math.max(0, Math.floor(x1 * sx));
  const my1 = Math.max(0, Math.floor(y1 * sy));
  const mx2 = Math.min(mw, Math.ceil(x2 * sx));
  const my2 = Math.min(mh, Math.ceil(y2 * sy));

  const out = new Uint8Array(targetW * targetH);
  if (mx2 <= mx1 || my2 <= my1) return out;

  for (let py = 0; py < targetH; py++) {
    const yIn = py * scale + padY;
    const ym = yIn * sy;
    if (ym < my1 || ym >= my2) continue;
    const ymFloor = Math.min(mh - 1, Math.floor(ym));
    for (let px = 0; px < targetW; px++) {
      const xIn = px * scale + padX;
      const xm = xIn * sx;
      if (xm < mx1 || xm >= mx2) continue;
      const xmFloor = Math.min(mw - 1, Math.floor(xm));
      const v = mask[ymFloor * mw + xmFloor];
      if (v >= MASK_THRESHOLD) out[py * targetW + px] = 1;
    }
  }
  return out;
}

function sampleMaskColor(imgPixels, mask) {
  // Median RGB under the mask. Median (rather than mean) keeps stray rim
  // pixels and stamped denomination text from shifting the color.
  const data = imgPixels.data;
  const rs = [], gs = [], bs = [];
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (!mask[i]) continue;
    rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2]);
  }
  if (rs.length < 8) return null;
  return [median(rs), median(gs), median(bs)];
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}


/* ── Clustering ───────────────────────────────────────────────────── */
function clusterIntoGroups(detections) {
  // Start each detection as its own singleton cluster, then merge closest
  // pairs in Lab space until the minimum pairwise distance exceeds the
  // threshold. N is small (~tens of chips), so O(N³) is fine.
  let clusters = detections.map((d, idx) => ({
    memberIdxs: [idx],
    sumLab: [d.lab[0], d.lab[1], d.lab[2]],
    sumRgb: [d.rgb[0], d.rgb[1], d.rgb[2]],
    center: d.lab,
  }));

  while (clusters.length > 1) {
    let best = { dist: Infinity, i: -1, j: -1 };
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = labDist(clusters[i].center, clusters[j].center);
        if (d < best.dist) best = { dist: d, i, j };
      }
    }
    if (best.dist > CLUSTER_DE_THRESHOLD) break;
    const a = clusters[best.i], b = clusters[best.j];
    const merged = {
      memberIdxs: a.memberIdxs.concat(b.memberIdxs),
      sumLab: [a.sumLab[0] + b.sumLab[0], a.sumLab[1] + b.sumLab[1], a.sumLab[2] + b.sumLab[2]],
      sumRgb: [a.sumRgb[0] + b.sumRgb[0], a.sumRgb[1] + b.sumRgb[1], a.sumRgb[2] + b.sumRgb[2]],
    };
    const n = merged.memberIdxs.length;
    merged.center = [merged.sumLab[0] / n, merged.sumLab[1] / n, merged.sumLab[2] / n];
    clusters.splice(best.j, 1);
    clusters[best.i] = merged;
  }

  return clusters.map(c => {
    const n = c.memberIdxs.length;
    const avgRgb = [
      Math.round(c.sumRgb[0] / n),
      Math.round(c.sumRgb[1] / n),
      Math.round(c.sumRgb[2] / n),
    ];
    const canonical = nearestCanonical(c.center);
    return {
      id: state.nextGroupId++,
      memberIdxs: c.memberIdxs,
      rgb: avgRgb,
      lab: c.center,
      canonical,
      count: n,
      denom: canonical.denom,
    };
  }).sort((a, b) => b.canonical.denom - a.canonical.denom);
}

function nearestCanonical(lab) {
  // Weighted Lab distance with L* heavily down-weighted: chip identity is
  // mostly hue+chroma, and L* drifts with photo exposure. A tiny non-zero
  // weight keeps Black distinguishable from saturated colors (Black's a*/b*
  // are ~0, so without any L* contribution any low-chroma chip ties it).
  const W_L = 0.1;
  let best = CANONICAL_CHIPS[0], bestD = Infinity;
  for (const c of CANONICAL_CHIPS) {
    const dL = (lab[0] - c.lab[0]) * W_L;
    const da = lab[1] - c.lab[1];
    const db = lab[2] - c.lab[2];
    const d = dL * dL + da * da + db * db;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}


/* ── Rendering: overlay ───────────────────────────────────────────── */
/* Tints the detection masks with each cluster's average RGB, then drops a
   small center dot over each chip so eye and row can line up at a glance. */
function renderOverlay() {
  const canvas = document.getElementById('previewCanvas');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(state.imageBitmap, 0, 0, state.workW, state.workH);

  const groupByIdx = new Map();
  for (const g of state.groups) {
    for (const idx of g.memberIdxs) groupByIdx.set(idx, g);
  }

  // Blend mask pixels with the group color in a single getImageData pass.
  const overlay = ctx.getImageData(0, 0, state.workW, state.workH);
  for (let i = 0; i < state.detections.length; i++) {
    const g = groupByIdx.get(i);
    if (!g) continue;
    const det = state.detections[i];
    const [r, gc, b] = g.rgb;
    const mask = det.mask;
    for (let j = 0, p = 0; j < mask.length; j++, p += 4) {
      if (!mask[j]) continue;
      overlay.data[p] = Math.round(overlay.data[p] * 0.35 + r * 0.65);
      overlay.data[p + 1] = Math.round(overlay.data[p + 1] * 0.35 + gc * 0.65);
      overlay.data[p + 2] = Math.round(overlay.data[p + 2] * 0.35 + b * 0.65);
    }
  }
  ctx.putImageData(overlay, 0, 0);

  // Center dot per chip: dark halo + group-colored core.
  const dotR = Math.max(3, state.workW / 260);
  for (let i = 0; i < state.detections.length; i++) {
    const g = groupByIdx.get(i);
    if (!g) continue;
    const d = state.detections[i];
    const [r, gc, b] = g.rgb;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.beginPath();
    ctx.arc(d.x, d.y, dotR * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgb(${r}, ${gc}, ${b})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}


/* ── Rendering: groups list ───────────────────────────────────────── */
function renderGroups() {
  const container = document.getElementById('groupsContainer');
  container.replaceChildren();
  const template = document.getElementById('groupTemplate').content;

  for (const group of state.groups) {
    const node = document.importNode(template, true);
    const rowEl = node.querySelector('.group');
    rowEl.dataset.groupId = String(group.id);

    const [r, g, b] = group.rgb;
    const swatch = node.querySelector('.swatch');
    swatch.style.background = `rgb(${r}, ${g}, ${b})`;

    const nameSelect = node.querySelector('.group-name');
    for (const c of CANONICAL_CHIPS) {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name;
      if (c.name === group.canonical.name) opt.selected = true;
      nameSelect.appendChild(opt);
    }
    node.querySelector('.group-hint').textContent = `detected ${group.memberIdxs.length}`;

    const countField = node.querySelector('.countField');
    const denomField = node.querySelector('.denomField');
    const subtotalField = node.querySelector('.subtotalField');
    countField.value = group.count;
    denomField.value = group.denom;

    // Changing the type re-binds the group to a new canonical and resets
    // its denom to that type's default. Swatch stays at the detected RGB —
    // it's the observed color, not the canonical's reference color.
    nameSelect.addEventListener('change', () => {
      const next = CANONICAL_CHIPS.find(c => c.name === nameSelect.value);
      if (!next) return;
      group.canonical = next;
      group.denom = next.denom;
      denomField.value = next.denom;
      updateSubtotal(group, subtotalField);
      updateTotals();
    });

    countField.addEventListener('input', () => {
      group.count = parseInt(countField.value) || 0;
      updateSubtotal(group, subtotalField);
      updateTotals();
    });
    denomField.addEventListener('input', () => {
      group.denom = parseFloat(denomField.value) || 0;
      updateSubtotal(group, subtotalField);
      updateTotals();
    });
    node.querySelector('.btn-remove').addEventListener('click', () => {
      state.groups = state.groups.filter(g => g.id !== group.id);
      renderGroups();
      renderOverlay();
      updateTotals();
    });

    updateSubtotal(group, subtotalField);
    container.appendChild(node);
  }
  updateTotals();
}

function updateSubtotal(group, field) {
  const sub = group.count * group.denom;
  field.value = '$' + sub.toFixed(2);
  field.classList.toggle('positive', sub > 0);
}

function updateTotals() {
  let totalChips = 0, totalValue = 0;
  for (const g of state.groups) {
    totalChips += g.count;
    totalValue += g.count * g.denom;
  }
  document.getElementById('totalTypesField').textContent = state.groups.length;
  document.getElementById('totalChipsField').textContent = totalChips;
  document.getElementById('totalValueField').textContent = '$' + totalValue.toFixed(2);
  const countLabel = document.getElementById('groupsCount');
  countLabel.textContent = state.groups.length
    ? `${state.groups.length} ${state.groups.length === 1 ? 'type' : 'types'}`
    : '';
}


/* ── View state helpers ───────────────────────────────────────────── */
function showPreview() {
  document.getElementById('dropzone').hidden = true;
  document.getElementById('previewWrap').hidden = false;
  document.getElementById('uploadActions').hidden = false;
}

function showResults() {
  document.getElementById('groupsSection').hidden = false;
  document.getElementById('totalsCard').hidden = false;
}

function resetToUpload() {
  state.imageBitmap = null;
  state.detections = [];
  state.groups = [];
  document.getElementById('dropzone').hidden = false;
  document.getElementById('previewWrap').hidden = true;
  document.getElementById('uploadActions').hidden = true;
  document.getElementById('groupsSection').hidden = true;
  document.getElementById('totalsCard').hidden = true;
  document.getElementById('photoInput').value = '';
  setStatus('');
}

function setStatus(text) {
  const el = document.getElementById('previewStatus');
  el.textContent = text;
  el.hidden = !text;
}


/* ── Event wiring ─────────────────────────────────────────────────── */
document.getElementById('photoInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) handleFile(file);
});

document.getElementById('redetectBtn').addEventListener('click', () => {
  if (state.imageBitmap) {
    drawImageToCanvas(state.imageBitmap);
    runDetection();
  }
});

document.getElementById('changePhotoBtn').addEventListener('click', () => {
  resetToUpload();
  document.getElementById('photoInput').click();
});

// Drag-and-drop
const dropzone = document.getElementById('dropzone');
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); dropzone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); dropzone.classList.remove('dragging');
}));
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// Start warming up the model in the background so the first detection is
// faster — best-effort, surface nothing to the user if it fails here.
loadSession().catch(err => console.warn('model preload failed:', err));
