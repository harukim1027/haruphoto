import type { PoseJoints, Pt } from './types';

// ── 시간적 스무딩 파라미터(전부 여기서 조정) ──
// alpha: EMA 계수(0~1). 클수록 반응 빠름/스무딩 약함, 작을수록 부드럽지만 둔함.
// hold: 검출 실패 프레임에서 직전 값을 유지하는 시간 → 한두 프레임 놓쳐도 안 사라짐.
export const SMOOTH = {
  poseAlpha: 0.35, // 관절 EMA
  silAlpha: 0.3, // 실루엣 EMA
  frameAlpha: 0.4, // 얼굴 프레이밍(cx/cy/size) EMA
  angleAlpha: 0.3, // 얼굴 각도(yaw/pitch/roll) EMA
  iouAlpha: 0.3, // IoU 점수 EMA(바/색 떨림 완화)
  holdMs: 500, // 검출 실패 시 직전 값 유지(ms). 이보다 길게 실패해야 숨김.
  silResampleN: 64, // 실루엣을 고정 점 개수로 리샘플(프레임 간 대응 안정화)
  minJointConf: 0.2, // 이 신뢰도 미만 관절은 갱신/표시 제외(부분 표시)
  minOutlinePts: 8, // 이보다 적은 실루엣 폴리곤은 무시
};

const POSE_KEYS: (keyof PoseJoints)[] = [
  'neck',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'root',
];

export function ema(prev: number, raw: number, a: number): number {
  return a * raw + (1 - a) * prev;
}

// 관절 EMA. 신뢰도 낮은 관절은 '갱신하지 않고' 직전 값 유지(전체가 사라지지 않게 부분 표시).
function emaPose(
  prev: PoseJoints | null,
  raw: PoseJoints,
  a: number,
  minC: number,
): PoseJoints {
  const out: PoseJoints = prev ? { ...prev } : {};
  for (const k of POSE_KEYS) {
    const r = raw[k];
    if (!r || r.c < minC) continue; // 약한 관절: 이전 값 유지
    const p = out[k];
    out[k] = p
      ? { x: ema(p.x, r.x, a), y: ema(p.y, r.y, a), c: r.c }
      : { ...r };
  }
  return out;
}

// 닫힌 폴리곤을 호 길이 기준 N개 균등 점으로 리샘플(점 개수 변동을 흡수해 EMA 대응 안정화).
export function resampleClosed(poly: Pt[], n: number): Pt[] {
  const m = poly.length;
  if (m < 3) return poly.map((p) => ({ ...p }));
  const seg = new Array<number>(m);
  let total = 0;
  for (let i = 0; i < m; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % m];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    seg[i] = d;
    total += d;
  }
  if (total <= 1e-9) return poly.map((p) => ({ ...p }));
  const out: Pt[] = [];
  const step = total / n;
  let idx = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (idx < m - 1 && acc + seg[idx] < target) {
      acc += seg[idx];
      idx++;
    }
    const a = poly[idx];
    const b = poly[(idx + 1) % m];
    const t = Math.min(1, Math.max(0, (target - acc) / (seg[idx] || 1e-9)));
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

// 리샘플된 폴리곤을 '최상단(최소 y) 점'에서 시작하도록 회전 → 프레임 간 시작점 튐 보정.
// (Moore 추적 시작점이 프레임마다 달라져도 대응이 유지되어 EMA 가 제대로 먹힌다.)
function rotateToTop(pts: Pt[]): Pt[] {
  let bi = 0;
  for (let i = 1; i < pts.length; i++) {
    if (
      pts[i].y < pts[bi].y ||
      (pts[i].y === pts[bi].y && pts[i].x < pts[bi].x)
    ) {
      bi = i;
    }
  }
  return bi === 0 ? pts : [...pts.slice(bi), ...pts.slice(0, bi)];
}

// 동일 길이 폴리곤 EMA.
function emaOutline(prev: Pt[] | null, raw: Pt[], a: number): Pt[] {
  if (!prev || prev.length !== raw.length) return raw.map((p) => ({ ...p }));
  return raw.map((p, i) => ({
    x: ema(prev[i].x, p.x, a),
    y: ema(prev[i].y, p.y, a),
  }));
}

// 스무더 입출력(LiveData 와 구조적으로 호환).
export interface SmoothFrame {
  pose?: PoseJoints;
  bodyOutline?: Pt[];
  iou: number;
  cx: number;
  cy: number;
  size: number;
  fw: number;
  fh: number;
  // 얼굴 각도(radian, mirror 보정됨). 떨림 방지 위해 함께 스무딩.
  yaw: number;
  pitch: number;
  roll: number;
  face: boolean; // 이 프레임에 실제 얼굴이 있었는지(각도 유효성)
}

/**
 * 라이브 포즈/실루엣/프레이밍을 시간적으로 스무딩 + 실패 프레임 hold.
 * - 매 프레임 raw 를 update()로 넣으면 부드러운 값을 돌려준다(없으면 직전 값 hold).
 * - holdMs 이상 연속 실패하면 null 반환(그때만 가이드 숨김).
 * 상태를 가지므로 useRef 등에 1개 인스턴스를 보관해 쓴다.
 */
export function createLiveSmoother() {
  let pose: PoseJoints | null = null;
  let poseT = 0;
  let outline: Pt[] | null = null;
  let outlineT = 0;
  let cx = 0;
  let cy = 0;
  let size = 0;
  let fw = 0;
  let fh = 0;
  let frameT = 0;
  let frameInit = false;
  let iou = 0;
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  let face = false;

  return {
    reset() {
      pose = null;
      outline = null;
      frameInit = false;
      poseT = outlineT = frameT = 0;
      iou = 0;
      yaw = pitch = roll = 0;
      face = false;
    },
    update(f: SmoothFrame | null, now: number): SmoothFrame | null {
      if (f) {
        if (f.pose && Object.keys(f.pose).length > 0) {
          pose = emaPose(pose, f.pose, SMOOTH.poseAlpha, SMOOTH.minJointConf);
          poseT = now;
        }
        if (f.bodyOutline && f.bodyOutline.length >= SMOOTH.minOutlinePts) {
          const rs = rotateToTop(
            resampleClosed(f.bodyOutline, SMOOTH.silResampleN),
          );
          outline = emaOutline(outline, rs, SMOOTH.silAlpha);
          outlineT = now;
        }
        if (!frameInit) {
          cx = f.cx;
          cy = f.cy;
          size = f.size;
          yaw = f.yaw;
          pitch = f.pitch;
          roll = f.roll;
          frameInit = true;
        } else {
          cx = ema(cx, f.cx, SMOOTH.frameAlpha);
          cy = ema(cy, f.cy, SMOOTH.frameAlpha);
          size = ema(size, f.size, SMOOTH.frameAlpha);
          yaw = ema(yaw, f.yaw, SMOOTH.angleAlpha);
          pitch = ema(pitch, f.pitch, SMOOTH.angleAlpha);
          roll = ema(roll, f.roll, SMOOTH.angleAlpha);
        }
        fw = f.fw;
        fh = f.fh;
        face = f.face;
        frameT = now;
        iou = ema(iou, f.iou, SMOOTH.iouAlpha);
      }
      // 만료(holdMs 초과) 시 비움
      if (now - poseT > SMOOTH.holdMs) pose = null;
      if (now - outlineT > SMOOTH.holdMs) outline = null;
      const frameAlive = now - frameT <= SMOOTH.holdMs;
      if (!pose && !outline && !frameAlive) return null;
      return {
        pose: pose ?? undefined,
        bodyOutline: outline ?? undefined,
        iou,
        cx,
        cy,
        size,
        fw,
        fh,
        yaw,
        pitch,
        roll,
        face,
      };
    },
  };
}
