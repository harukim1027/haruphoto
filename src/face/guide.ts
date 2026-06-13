import type { FaceFeatures, Joint } from './types';
import { poseAngles, type MatchScores, type PoseAngles } from './matchFace';

function angDiff(a?: number, b?: number): number {
  'worklet';
  if (a == null || b == null) return -1;
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

// 손목/팔꿈치 y로 "올려/내려" 판단 (top-left: y 클수록 아래)
function upDown(refJ?: Joint, liveJ?: Joint): string {
  'worklet';
  if (!refJ || !liveJ) return '사진처럼 맞춰요';
  return liveJ.y > refJ.y ? '올려보세요' : '내려보세요';
}

function poseGuide(ref: FaceFeatures, live: FaceFeatures): string {
  'worklet';
  const ra = poseAngles(ref.pose);
  const la = poseAngles(live.pose);
  const keys: (keyof PoseAngles)[] = [
    'shoulder',
    'rightUpper',
    'rightFore',
    'leftUpper',
    'leftFore',
    'torso',
  ];
  let worst = '';
  let max = -1;
  for (const k of keys) {
    const d = angDiff(ra[k], la[k]);
    if (d > max) {
      max = d;
      worst = k;
    }
  }
  const rp = ref.pose;
  const lp = live.pose;
  switch (worst) {
    case 'shoulder': {
      // 어깨선 기울기 비교
      const refT = ra.shoulder ?? 0;
      const liveT = la.shoulder ?? 0;
      return liveT > refT ? '어깨를 왼쪽으로 기울여요' : '어깨를 오른쪽으로 기울여요';
    }
    case 'rightUpper':
    case 'rightFore':
      return `오른팔을 ${upDown(rp?.rightWrist, lp?.rightWrist)}`;
    case 'leftUpper':
    case 'leftFore':
      return `왼팔을 ${upDown(rp?.leftWrist, lp?.leftWrist)}`;
    case 'torso':
      return '몸을 사진처럼 살짝 틀어요';
    default:
      return '자세를 사진처럼 맞춰보세요';
  }
}

/**
 * 가장 어긋난 항목 하나에 대한 한국어 코칭. 자세(상체)를 우선.
 */
export function guideText(
  ref: FaceFeatures,
  live: FaceFeatures,
  scores: MatchScores,
): string {
  'worklet';
  let key = 'framing';
  let min = scores.framing;
  if (scores.hasPose && scores.pose < min) {
    min = scores.pose;
    key = 'pose';
  }
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
  if (min >= 0.8) return '좋아요! 그대로 유지하세요';

  if (key === 'pose') return poseGuide(ref, live);

  if (key === 'framing') {
    const ds = live.framing.size - ref.framing.size;
    const dy = live.framing.cy - ref.framing.cy;
    const dx = live.framing.cx - ref.framing.cx;
    if (Math.abs(ds) > 0.12) return ds < 0 ? '조금 더 가까이' : '조금 더 멀리';
    if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? '조금 위로' : '조금 아래로';
    return dx > 0 ? '살짝 왼쪽으로' : '살짝 오른쪽으로';
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
    if (aPitch >= aRoll) return dpitch > 0 ? '턱을 살짝 내려' : '턱을 살짝 들어';
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
  return '카메라를 봐주세요';
}
