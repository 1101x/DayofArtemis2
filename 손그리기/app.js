/**
 * 손가락 드로잉 v5
 * ─ 오른손 엄지·검지 (펼친 경우만), hue 순환 색상
 * ─ 스트로크 완료 후 1초 페이드 아웃
 * ─ 왼손 주먹 → 그리기 모드  |  왼손 활짝 → 지우기
 * ─ 버튼 위에 손가락 올리면 즉시 실행
 * ─ 현재 모드 버튼 항상 활성화 표시
 */

import {
  FilesetResolver,
  HandLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs';

// ── DOM ───────────────────────────────────────────────────────────────────
const video = document.getElementById('webcam');
const drawCanvas = document.getElementById('drawCanvas');
const btnDraw = document.getElementById('btnDraw');
const btnErase = document.getElementById('btnErase');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const modeIndicator = document.getElementById('modeIndicator');
const modeText = document.getElementById('modeText');

const ctx = drawCanvas.getContext('2d');

// ── Constants ─────────────────────────────────────────────────────────────
const FADE_TOTAL = 1000;   // ms — 페이드 총 시간
const FADE_START = 500;   // ms — 페이드 시작 지점 (완료 후 N ms)
const GESTURE_COOL = 1000;   // ms — 제스처 쿨다운

// ── 손가락 정의 (엄지·검지만) ─────────────────────────────────────────────
const FINGER_DEFS = [
  // { idx: 4, pip: 3, name: 'thumb' },
  { idx: 8, pip: 6, name: 'index' },
  { idx: 12, pip: 10, name: 'middle' },
];

// ── State ─────────────────────────────────────────────────────────────────
let handLandmarker = null;
let isDrawing = false;
let lastVideoTime = -1;
let lastGestureTime = 0;
let hue = 0;   // 전역 hue, 매 프레임 +1 순환

// 완성된 스트로크: { segments:[{x1,y1,x2,y2,hue}], endTime }
const finalStrokes = [];

// 현재 그리는 중인 스트로크 (손가락별)
const activeStrokes = {};

// 손가락별 이전 좌표
const prevPos = { middle: null, index: null };

// 버튼 호버 상태 (즉시 실행 — 중복 방지용 inside 플래그)
const btnHover = {
  draw: { inside: false },
  erase: { inside: false },
};

// ── Canvas resize ─────────────────────────────────────────────────────────
function resizeCanvas() {
  drawCanvas.width = window.innerWidth;
  drawCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── 손가락 펼침 감지 ──────────────────────────────────────────────────────
function isFingerExtended(lms, tipIdx, pipIdx) {
  const handUp = lms[9].y < lms[0].y;  // 중지MCP가 손목보다 위 = 손 위 방향
  return handUp
    ? lms[tipIdx].y < lms[pipIdx].y
    : lms[tipIdx].y > lms[pipIdx].y;
}

// ── 스트로크 확정 (펜 업) ─────────────────────────────────────────────────
function finalizeStroke(name) {
  const s = activeStrokes[name];
  if (s?.segments.length > 0) {
    finalStrokes.push({ segments: s.segments, endTime: performance.now() });
  }
  delete activeStrokes[name];
  prevPos[name] = null;
}

function finalizeAllStrokes() {
  Object.keys(activeStrokes).forEach(finalizeStroke);
  Object.keys(prevPos).forEach(k => (prevPos[k] = null));
}

// ── Mode helpers ──────────────────────────────────────────────────────────
function setActiveBtn(mode) {            // mode: 'draw' | 'erase' | null
  btnDraw.classList.toggle('active', mode === 'draw');
  btnErase.classList.toggle('active', mode === 'erase');
}

function activateDraw() {
  isDrawing = true;
  setActiveBtn('draw');
  modeIndicator.className = 'draw-mode';
  modeText.textContent = '그리기 모드';
}

function activateErase() {
  isDrawing = false;
  finalizeAllStrokes();
  finalStrokes.length = 0;
  setActiveBtn('erase');
  modeIndicator.className = '';
  modeText.textContent = '지우기 완료';
  // 지우기는 일회성 — 잠시 후 비활성화
  setTimeout(() => {
    setActiveBtn(null);
    modeText.textContent = '대기 중';
  }, 800);
}

// ── Gesture detection (왼손) ──────────────────────────────────────────────
function detectGesture(lms) {
  const handUp = lms[9].y < lms[0].y;
  const fingers = [
    { tip: 8, mcp: 5 },
    { tip: 12, mcp: 9 },
    { tip: 16, mcp: 13 },
    { tip: 20, mcp: 17 },
  ];
  let curled = 0, extended = 0;
  fingers.forEach(({ tip, mcp }) => {
    (handUp ? lms[tip].y > lms[mcp].y : lms[tip].y < lms[mcp].y)
      ? curled++ : extended++;
  });
  if (curled >= 3) return 'fist';
  if (extended >= 3) return 'open';
  return 'none';
}

// ── 버튼 즉시 실행 체크 ───────────────────────────────────────────────────
function checkButtonHover(sx, sy) {
  [
    { key: 'draw', el: btnDraw, action: activateDraw },
    { key: 'erase', el: btnErase, action: activateErase },
  ].forEach(({ key, el, action }) => {
    const r = el.getBoundingClientRect();
    const inside = sx >= r.left && sx <= r.right && sy >= r.top && sy <= r.bottom;
    const h = btnHover[key];
    if (inside && !h.inside) { h.inside = true; action(); }
    else if (!inside) { h.inside = false; }
  });
}

// ── Redraw canvas ─────────────────────────────────────────────────────────
function drawSegs(segs, alpha) {
  ctx.globalAlpha = alpha;
  segs.forEach(({ x1, y1, x2, y2, hue: h }) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = `hsl(${h}, 100%, 55%)`;
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

function redrawCanvas() {
  const now = performance.now();
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

  // 완성된 스트로크 — 페이드
  for (let i = finalStrokes.length - 1; i >= 0; i--) {
    const s = finalStrokes[i];
    const age = now - s.endTime;
    if (age >= FADE_TOTAL) { finalStrokes.splice(i, 1); continue; }
    const alpha = age < FADE_START ? 1 : 1 - (age - FADE_START) / (FADE_TOTAL - FADE_START);
    drawSegs(s.segments, alpha);
  }

  // 현재 그리는 스트로크 — 불투명
  Object.values(activeStrokes).forEach(s => drawSegs(s.segments, 1));

  ctx.globalAlpha = 1;
}

// ── MediaPipe init ────────────────────────────────────────────────────────
async function initModel() {
  loadingText.textContent = '애플 파이를 먹으며🥧 미디어 파이 로딩 중…';
  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.65,
      minHandPresenceConfidence: 0.65,
      minTrackingConfidence: 0.65,
    });
    loadingOverlay.classList.add('hidden');
    startCamera();
  } catch (err) {
    loadingText.textContent = '오류: ' + err.message;
    console.error(err);
  }
}

// ── Camera ────────────────────────────────────────────────────────────────
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.addEventListener('loadeddata', () => requestAnimationFrame(renderLoop), { once: true });
}

// ── Main render loop ──────────────────────────────────────────────────────
function renderLoop() {
  requestAnimationFrame(renderLoop);
  if (!video.videoWidth || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  hue = (hue + 1) % 360;   // 매 프레임 hue 증가

  const result = handLandmarker.detectForVideo(video, performance.now());

  let rightHandLms = null;
  let dwellTip = null;

  if (result.landmarks?.length) {
    result.handedness.forEach((handedness, i) => {
      const label = handedness[0].categoryName;
      const lms = result.landmarks[i];

      // 버튼 호버: 검지 좌표 (미러 적용)
      dwellTip = { x: (1 - lms[8].x) * drawCanvas.width, y: lms[8].y * drawCanvas.height };

      if (label === 'Left') {
        const now = performance.now();
        const g = detectGesture(lms);
        if (g !== 'none' && now - lastGestureTime > GESTURE_COOL) {
          lastGestureTime = now;
          if (g === 'fist') activateDraw();
          if (g === 'open') activateErase();
        }
      } else {
        rightHandLms = lms;
      }
    });
  }

  // 버튼 즉시 실행 체크
  if (dwellTip) checkButtonHover(dwellTip.x, dwellTip.y);
  else { btnHover.draw.inside = false; btnHover.erase.inside = false; }

  // 오른손 드로잉 (엄지·검지, 펼친 경우만)
  if (rightHandLms && isDrawing) {
    FINGER_DEFS.forEach(({ idx, pip, name }) => {
      if (isFingerExtended(rightHandLms, idx, pip)) {
        if (!activeStrokes[name]) activeStrokes[name] = { segments: [] };
        const lm = rightHandLms[idx];
        const x = (1 - lm.x) * drawCanvas.width;
        const y = lm.y * drawCanvas.height;
        const p = prevPos[name];
        if (p) activeStrokes[name].segments.push({ x1: p.x, y1: p.y, x2: x, y2: y, hue });
        prevPos[name] = { x, y };
      } else {
        if (activeStrokes[name]) finalizeStroke(name);
        else prevPos[name] = null;
      }
    });
  } else {
    finalizeAllStrokes();
  }

  redrawCanvas();
}

// ── Button click handlers ─────────────────────────────────────────────────
btnDraw.addEventListener('click', activateDraw);
btnErase.addEventListener('click', activateErase);

// ── Boot ──────────────────────────────────────────────────────────────────
initModel();
