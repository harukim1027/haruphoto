import type { FaceFeatures } from './types';
import type { MatchScores } from './matchFace';

/**
 * 가장 많이 어긋난 항목 하나에 대해 방향이 담긴 한국어 코칭 문구를 돌려준다.
 * (한 번에 하나씩 — 동시에 여러 개 띄우면 혼란)
 *
 * 주의: yaw/roll/gaze 의 좌우 방향은 Vision 좌표계 + 전면 미러 보정에 따라
 * 뒤집힐 수 있다. 실기기에서 보고 부호를 맞춰야 한다.
 */
export function guideText(
  ref: FaceFeatures,
  live: FaceFeatures,
  scores: MatchScores,
): string {
  'worklet';
  let key = 'framing';
  let min = scores.framing;
  if (scores.orientation < min) {
    min = scores.orientation;
    key = 'orientation';
  }
  if (scores.expression < min) {
    min = scores.expression;
    key = 'expression';
  }
  if (scores.gaze < min) {
    min = scores.gaze;
    key = 'gaze';
  }
  if (scores.hasBody && scores.body < min) {
    min = scores.body;
    key = 'body';
  }
  if (min >= 0.8) return '좋아요! 그대로 유지하세요';

  if (key === 'body') {
    if (!live.body || !ref.body) return '상체가 더 보이게 뒤로';
    const dcx = live.body.cx - ref.body.cx;
    const dw = live.body.w - ref.body.w;
    if (Math.abs(dw) > 0.18) return dw < 0 ? '상체를 더 보이게' : '조금 더 가까이';
    if (Math.abs(dcx) > 0.08) return dcx > 0 ? '몸을 살짝 왼쪽으로' : '몸을 살짝 오른쪽으로';
    return '자세를 사진처럼 맞춰보세요';
  }

  if (key === 'framing') {
    const ds = live.framing.size - ref.framing.size;
    const dy = live.framing.cy - ref.framing.cy;
    const dx = live.framing.cx - ref.framing.cx;
    if (Math.abs(ds) > 0.12) return ds < 0 ? '조금 더 가까이' : '조금 더 멀리';
    if (Math.abs(dy) > Math.abs(dx)) {
      return dy > 0 ? '얼굴을 조금 위로' : '얼굴을 조금 아래로';
    }
    return dx > 0 ? '얼굴을 살짝 왼쪽으로' : '얼굴을 살짝 오른쪽으로';
  }

  if (key === 'orientation') {
    const dyaw = live.orientation.yaw - ref.orientation.yaw;
    const dpitch = live.orientation.pitch - ref.orientation.pitch;
    const droll = live.orientation.roll - ref.orientation.roll;
    const aYaw = Math.abs(dyaw);
    const aPitch = Math.abs(dpitch);
    const aRoll = Math.abs(droll);
    if (aYaw >= aPitch && aYaw >= aRoll) {
      return dyaw > 0 ? '고개를 살짝 오른쪽으로' : '고개를 살짝 왼쪽으로';
    }
    if (aPitch >= aRoll) {
      return dpitch > 0 ? '턱을 살짝 내려' : '턱을 살짝 들어';
    }
    return droll > 0 ? '고개를 시계방향으로 살짝' : '고개를 시계반대로 살짝';
  }

  if (key === 'expression') {
    const ds = live.expression.smile - ref.expression.smile;
    const dm = live.expression.mouthOpen - ref.expression.mouthOpen;
    if (Math.abs(ds) >= Math.abs(dm)) {
      return ds < 0 ? '더 환하게 웃어보세요' : '미소를 살짝 줄여요';
    }
    return dm < 0 ? '입을 살짝 벌려요' : '입을 살짝 다물어요';
  }

  // gaze
  return '카메라를 봐주세요';
}
