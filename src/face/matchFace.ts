import type { FaceFeatures } from './types';

export interface MatchScores {
  framing: number; // 0~1
  orientation: number;
  expression: number;
  gaze: number;
  body: number; // 자세 (반신 셀카; 레퍼런스에 몸 없으면 항상 1)
  hasBody: boolean; // 레퍼런스에 자세 항목이 있는지 (UI 표시 여부)
  overall: number;
}

// 허용 오차 (실기기 실측으로 튜닝 가능)
const TOL = {
  pos: 0.12, // 구도 위치 거리(정규화)
  size: 0.18, // 크기 비율 차
  angle: 0.26, // 각도 차(radian, ~15°)
  expr: 0.18, // 표정 계수 차
  gaze: 0.22, // 시선 위치 차
  bodyPos: 0.15, // 몸 중심 거리
  bodySize: 0.25, // 몸 크기 비율 차
  headOff: 0.12, // 머리-몸 상대 위치(기울기/돌림)
};

function score(diff: number, tol: number): number {
  'worklet';
  return Math.max(0, Math.min(1, 1 - diff / tol));
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

  // 각도
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

  // 자세(반신): 레퍼런스에 몸이 있을 때만. 몸 중심/크기 + 머리-몸 상대 위치(기울기·돌림)
  const hasBody = !!ref.body;
  let body = 1;
  if (ref.body) {
    if (!live.body) {
      body = 0; // 몸을 더 보여줘야 함
    } else {
      const dc = Math.hypot(ref.body.cx - live.body.cx, ref.body.cy - live.body.cy);
      const dw = Math.abs(ref.body.w - live.body.w) / Math.max(ref.body.w, 0.05);
      // 머리가 몸 대비 어디에 있나 (고개 기울이기/돌리기 → 머리-몸 오프셋)
      const roX = ref.framing.cx - ref.body.cx;
      const roY = ref.framing.cy - ref.body.cy;
      const loX = live.framing.cx - live.body.cx;
      const loY = live.framing.cy - live.body.cy;
      const doff = Math.hypot(roX - loX, roY - loY);
      body =
        (score(dc, TOL.bodyPos) +
          score(dw, TOL.bodySize) +
          score(doff, TOL.headOff)) /
        3;
    }
  }

  // 종합: 자세가 있으면 5분할, 없으면 4분할 가중
  const overall = hasBody
    ? framing * 0.22 +
      orientation * 0.24 +
      expression * 0.18 +
      gaze * 0.14 +
      body * 0.22
    : framing * 0.3 + orientation * 0.3 + expression * 0.22 + gaze * 0.18;
  return { framing, orientation, expression, gaze, body, hasBody, overall };
}

export const MATCH_THRESHOLD = 0.7; // 각 항목 합격선
export const SHUTTER_HOLD_MS = 600; // 임계 유지 시간
export const SHUTTER_COOLDOWN_MS = 3000;
