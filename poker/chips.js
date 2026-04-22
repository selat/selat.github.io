/* ════════════════════════════════════════════════════════════════════
   CHIPS.JS — Photo-based poker chip counter
   ════════════════════════════════════════════════════════════════════
   Pipeline on a user-uploaded photo:
     1. Fit image into a 1200px work canvas
     2. HoughCircles → candidate chip circles
     3. Median color sampled in an annulus (avoids face pattern/text)
     4. Convert samples to Lab, agglomerative-cluster by ΔE
     5. Match each cluster to a canonical chip color → default denom
     6. Draw colored outlines on overlay canvas, render group rows

   Assumes flat-laid, top-down photos. Stacks are not handled in v1.
   ════════════════════════════════════════════════════════════════════ */


/* ── Canonical chip colors (typical US cash game) ─────────────────── */
const CANONICAL_CHIPS = [
  { name: 'White', rgb: [240, 240, 240], denom: 1 },
  { name: 'Red', rgb: [200, 40, 40], denom: 5 },
  { name: 'Blue', rgb: [40, 80, 180], denom: 10 },
  { name: 'Green', rgb: [40, 140, 60], denom: 25 },
  { name: 'Black', rgb: [30, 30, 30], denom: 100 },
  { name: 'Purple', rgb: [110, 50, 150], denom: 500 },
  { name: 'Yellow', rgb: [230, 200, 40], denom: 1000 },
  { name: 'Orange', rgb: [230, 120, 40], denom: 20 },
  { name: 'Pink', rgb: [230, 130, 170], denom: 2 },
  { name: 'Gray', rgb: [120, 120, 120], denom: 50 },
];

/* Precompute Lab for canonical colors. */
CANONICAL_CHIPS.forEach(c => { c.lab = rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]); });


/* ── Detection params ─────────────────────────────────────────────── */
const WORK_MAX_DIM = 1200;
const CLUSTER_DE_THRESHOLD = 22;   // ΔE76 below which two clusters merge
const HOUGH = {
  dp: 1,
  minDistFrac: 0.08,              // of work image max dim
  param1: 200,                     // Canny upper
  param2: 28,                      // accumulator threshold (lower = more)
  minRadiusFrac: 0.03,
  maxRadiusFrac: 0.12,
};


/* ── State ────────────────────────────────────────────────────────── */
const state = {
  openCvReady: false,
  pendingImage: null,              // queued while OpenCV still initializes
  imageBitmap: null,                // drawn-to-canvas source
  workW: 0,
  workH: 0,
  detections: [],                  // [{ x, y, r, rgb, lab }]
  groups: [],                      // see makeGroup()
  nextGroupId: 1,
};


/* ── OpenCV readiness ─────────────────────────────────────────────── */
/* The <script onload> in chips.html calls this once opencv.js has loaded;
   WASM init lands shortly after via onRuntimeInitialized. */
window.onOpenCvReady = function () {
  if (typeof cv === 'undefined') return;
  if (cv.getBuildInformation) {
    handleOpenCvReady();
  } else {
    cv.onRuntimeInitialized = handleOpenCvReady;
  }
};

function handleOpenCvReady() {
  state.openCvReady = true;
  if (state.pendingImage) {
    const img = state.pendingImage;
    state.pendingImage = null;
    runDetection(img);
  }
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
      setStatus(state.openCvReady ? 'Detecting chips…' : 'Loading detector…');
      if (state.openCvReady) runDetection(img);
      else state.pendingImage = img;
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
function runDetection(img) {
  if (!state.openCvReady) { state.pendingImage = img; return; }
  setStatus('Detecting chips…');
  // Defer so the status text actually paints before we block on CV work.
  setTimeout(() => {
    try {
      const detections = detectCircles();
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
  }, 20);
}

function detectCircles() {
  const canvas = document.getElementById('previewCanvas');
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const circles = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.medianBlur(gray, gray, 5);

    const dim = Math.max(state.workW, state.workH);
    cv.HoughCircles(
      gray, circles, cv.HOUGH_GRADIENT,
      HOUGH.dp,
      Math.max(8, dim * HOUGH.minDistFrac),
      HOUGH.param1,
      HOUGH.param2,
      Math.max(6, Math.round(dim * HOUGH.minRadiusFrac)),
      Math.max(20, Math.round(dim * HOUGH.maxRadiusFrac))
    );

    const out = [];
    const imgData = canvas.getContext('2d').getImageData(0, 0, state.workW, state.workH);
    for (let i = 0; i < circles.cols; i++) {
      const x = circles.data32F[i * 3];
      const y = circles.data32F[i * 3 + 1];
      const r = circles.data32F[i * 3 + 2];
      const rgb = sampleAnnulusColor(imgData, x, y, r);
      if (!rgb) continue;
      out.push({ x, y, r, rgb, lab: rgbToLab(rgb[0], rgb[1], rgb[2]) });
    }
    return out;
  } finally {
    src.delete(); gray.delete(); circles.delete();
  }
}

function sampleAnnulusColor(imgData, cx, cy, r) {
  const w = imgData.width, h = imgData.height, data = imgData.data;
  const rs = [], gs = [], bs = [];
  const rInner = r * 0.35, rOuter = r * 0.85;
  const angleSteps = 24, radiusSteps = 4;
  for (let a = 0; a < angleSteps; a++) {
    const theta = (a / angleSteps) * Math.PI * 2;
    for (let s = 0; s < radiusSteps; s++) {
      const rr = rInner + (rOuter - rInner) * (s / (radiusSteps - 1));
      const px = Math.round(cx + Math.cos(theta) * rr);
      const py = Math.round(cy + Math.sin(theta) * rr);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const idx = (py * w + px) * 4;
      rs.push(data[idx]); gs.push(data[idx + 1]); bs.push(data[idx + 2]);
    }
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
  let best = CANONICAL_CHIPS[0], bestD = Infinity;
  for (const c of CANONICAL_CHIPS) {
    const d = labDist(lab, c.lab);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}


/* ── Rendering: overlay ───────────────────────────────────────────── */
/* For each detection: a dark halo (visible on light backgrounds), a
   thin white inner rim (keeps dark-chip outlines visible on dark
   photos), the group's color as the main stroke, and a center dot
   marking the detected center. */
function renderOverlay() {
  const canvas = document.getElementById('previewCanvas');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(state.imageBitmap, 0, 0, state.workW, state.workH);

  const groupByIdx = new Map();
  for (const g of state.groups) {
    for (const idx of g.memberIdxs) groupByIdx.set(idx, g);
  }

  const w = Math.max(4.5, state.workW / 100);

  for (let i = 0; i < state.detections.length; i++) {
    const g = groupByIdx.get(i);
    if (!g) continue;
    const d = state.detections[i];
    const [r, gc, b] = g.rgb;
    const fill = `rgb(${r}, ${gc}, ${b})`;

    // Dark halo
    ctx.lineWidth = w + 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.stroke();

    // Bright white inner rim
    ctx.lineWidth = w + 2.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.stroke();

    // Group-colored main stroke
    ctx.lineWidth = w;
    ctx.strokeStyle = fill;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.beginPath();
    ctx.arc(d.x, d.y, w * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(d.x, d.y, w * 0.7, 0, Math.PI * 2);
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

    node.querySelector('.group-name').textContent = group.canonical.name;
    node.querySelector('.group-hint').textContent = `detected ${group.memberIdxs.length}`;

    const countField = node.querySelector('.countField');
    const denomField = node.querySelector('.denomField');
    const subtotalField = node.querySelector('.subtotalField');
    countField.value = group.count;
    denomField.value = group.denom;

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
    runDetection(state.imageBitmap);
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
