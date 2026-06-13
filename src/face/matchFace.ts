import type { FaceFeatures, Joint, PoseJoints } from './types';

export interface MatchScores {
  pose: number; // 자세(상체) — 주력
  framing: number;
  expression: number;
  gaze: number;
  orientation: number;
  hasPose: boolean;
  overall: number;
}

const TOL = {
  pos: 0.12,
  size: 0.18,
  angle: 0.26, // 고개 각도(radian)
  expr: 0.18,
  gaze: 0.22,
  poseAngle: 0.45, // 상체 관절 각도 허용오차(radian, ~26°)
  poseRel: 0.5, // 어깨 기준 정규화 좌표 거리 허용오차(어깨너비 단위)
};

function score(diff: number, tol: number): number {
  'worklet';
  return Math.max(0, Math.min(1, 1 - diff / tol));
}

// 두 관절 사이 벡터 각도(radian). 신뢰도 낮거나 없으면 undefined.
function ang(a?: Joint, b?: Joint): number | undefined {
  'worklet';
  if (!a || !b || a.c < 0.2 || b.c < 0.2) return undefined;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// 상체 자세를 각도 집합으로 (위치/크기 무관)
export interface PoseAngles {
  shoulder?: number; // 어깨선 기울기
  leftUpper?: number; // 왼 어깨→팔꿈치
  leftFore?: number; // 왼 팔꿈치→손목
  rightUpper?: number;
  rightFore?: number;
  torso?: number; // 목→골반
}

export function poseAngles(p?: PoseJoints): PoseAngles {
  'worklet';
  if (!p) return {};
  return {
    shoulder: ang(p.leftShoulder, p.rightShoulder),
    leftUpper: ang(p.leftShoulder, p.leftElbow),
    leftFore: ang(p.leftElbow, p.leftWrist),
    rightUpper: ang(p.rightShoulder, p.rightElbow),
    rightFore: ang(p.rightElbow, p.rightWrist),
    torso: ang(p.root, p.neck),
  };
}

function angDiff(a?: number, b?: number): number | undefined {
  'worklet';
  if (a == null || b == null) return undefined;
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

// 어깨중점을 원점, 어깨너비를 스케일로 한 정규화 좌표(위치·크기 불변)
type NPose = Partial<Record<keyof PoseJoints, { x: number; y: number }>>;
export function normalizePose(p?: PoseJoints): NPose | null {
  'worklet';
  if (!p) return null;
  const lS = p.leftShoulder;
  const rS = p.rightShoulder;
  if (!lS || !rS || lS.c < 0.3 || rS.c < 0.3) return null;
  const ox = (lS.x + rS.x) / 2;
  const oy = (lS.y + rS.y) / 2;
  const w = Math.hypot(rS.x - lS.x, rS.y - lS.y) || 0.01;
  const keys: (keyof PoseJoints)[] = [
    'neck',
    'leftShoulder',
    'rightShoulder',
    'leftElbow',
    'rightElbow',
    'leftWrist',
    'rightWrist',
    'root',
  ];
  const out: NPose = {};
  for (const k of keys) {
    const j = p[k];
    if (j && j.c > 0.3) out[k] = { x: (j.x - ox) / w, y: (j.y - oy) / w };
  }
  return out;
}

// 어깨 기준 정규화 좌표 거리로 자세 일치율 (위치/크기/화면비 무관)
export function matchPose(ref?: PoseJoints, live?: PoseJoints): number {
  'worklet';
  const rn = normalizePose(ref);
  const ln = normalizePose(live);
  if (!rn || !ln) return 0;
  const keys: (keyof PoseJoints)[] = [
    'neck',
    'leftElbow',
    'rightElbow',
    'leftWrist',
    'rightWrist',
    'root',
  ];
  let sum = 0;
  let n = 0;
  for (const k of keys) {
    const a = rn[k];
    const b = ln[k];
    if (a && b) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      sum += score(d, TOL.poseRel);
      n += 1;
    }
  }
  // 공통 관절이 없으면 어깨선만이라도 맞으면 통과(어깨너비 정규화라 항상 1)
  return n === 0 ? 0.5 : sum / n;
}

export function matchFace(ref: FaceFeatures, live: FaceFeatures): MatchScores {
  'worklet';
  // 구도
  const dpos = Math.hypot(
    ref.framing.cx - live.framing.cx,
    ref.framing.cy - live.framing.cy,
  );
  const dsize =
    Math.abs(ref.framing.size - live.framing.size) /
    Math.max(ref.framing.size, 0.01);
  const framing = (score(dpos, TOL.pos) + score(dsize, TOL.size)) / 2;

  // 고개 각도
  const dyaw = Math.abs(ref.orientation.yaw - live.orientation.yaw);
  const dpitch = Math.abs(ref.orientation.pitch - live.orientation.pitch);
  const droll = Math.abs(ref.orientation.roll - live.orientation.roll);
  const orientation =
    (score(dyaw, TOL.angle) +
      score(dpitch, TOL.angle) +
      score(droll, TOL.angle)) /
    3;

  // 표정
  const e = ref.expression;
  const l = live.expression;
  const eyeRef = (e.leftEyeOpen + e.rightEyeOpen) / 2;
  const eyeLive = (l.leftEyeOpen + l.rightEyeOpen) / 2;
  const expression =
    (score(Math.abs(e.mouthOpen - l.mouthOpen), TOL.expr) +
      score(Math.abs(e.smile - l.smile), TOL.expr) +
      score(Math.abs(eyeRef - eyeLive), TOL.expr)) /
    3;

  // 시선
  const dgaze = Math.hypot(ref.gaze.x - live.gaze.x, ref.gaze.y - live.gaze.y);
  const gaze = score(dgaze, TOL.gaze);

  // 자세(상체) — 주력. 레퍼런스에 포즈가 있을 때만.
  const hasPose = !!ref.pose;
  const pose = hasPose ? matchPose(ref.pose, live.pose) : 1;

  // 종합: 자세 > 구도 > 각도 > 표정 > 시선
  const overall = hasPose
    ? pose * 0.4 +
      framing * 0.2 +
      orientation * 0.15 +
      expression * 0.15 +
      gaze * 0.1
    : framing * 0.3 + orientation * 0.3 + expression * 0.22 + gaze * 0.18;

  return { pose, framing, expression, gaze, orientation, hasPose, overall };
}

export const MATCH_THRESHOLD = 0.7;
export const SHUTTER_HOLD_MS = 600;
export const SHUTTER_COOLDOWN_MS = 3000;
