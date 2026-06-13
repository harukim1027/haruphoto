import { MIN_CONFIDENCE } from './skeleton';

/**
 * 포즈 일치율 계산.
 *
 * 모든 함수는 프레임 프로세서(워크릿) 안에서 호출되므로
 * 'worklet' 지시어가 필요하다. JS 스레드에서도 그대로 호출 가능.
 *
 * 알고리즘:
 * 1. 양쪽 골반 중점을 원점으로 평행이동
 * 2. 어깨 중점~골반 중점 거리(몸통 길이)로 스케일 정규화
 *    → 사람이 화면 어디에 있든, 얼마나 크게 잡히든 무관해짐
 * 3. 정규화된 (x, y) 좌표 벡터끼리 코사인 유사도
 *    (양쪽 포즈 모두에서 신뢰도가 충분한 키포인트만 사용)
 */

const HIP_L = 11;
const HIP_R = 12;
const SHOULDER_L = 5;
const SHOULDER_R = 6;

/** kp[i*3]=y, kp[i*3+1]=x, kp[i*3+2]=score */
export function normalizePose(kp: ArrayLike<number>): Float32Array | null {
  'worklet';
  const hipY = (Number(kp[HIP_L * 3]) + Number(kp[HIP_R * 3])) / 2;
  const hipX = (Number(kp[HIP_L * 3 + 1]) + Number(kp[HIP_R * 3 + 1])) / 2;
  const shY =
    (Number(kp[SHOULDER_L * 3]) + Number(kp[SHOULDER_R * 3])) / 2;
  const shX =
    (Number(kp[SHOULDER_L * 3 + 1]) + Number(kp[SHOULDER_R * 3 + 1])) / 2;

  const torso = Math.hypot(shX - hipX, shY - hipY);
  if (torso < 1e-4) return null; // 몸통이 안 잡힘 → 매칭 불가

  const out = new Float32Array(17 * 3);
  for (let i = 0; i < 17; i++) {
    out[i * 3] = (Number(kp[i * 3]) - hipY) / torso; // y
    out[i * 3 + 1] = (Number(kp[i * 3 + 1]) - hipX) / torso; // x
    out[i * 3 + 2] = Number(kp[i * 3 + 2]); // score 유지
  }
  return out;
}

/**
 * 두 포즈의 일치율 (0~1). 비교 불가능하면 -1.
 * @param a 정규화된 포즈 (normalizePose 결과)
 * @param b 정규화된 포즈
 */
export function poseSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  'worklet';
  let dot = 0;
  let na = 0;
  let nb = 0;
  let used = 0;

  for (let i = 0; i < 17; i++) {
    const sa = Number(a[i * 3 + 2]);
    const sb = Number(b[i * 3 + 2]);
    if (sa < MIN_CONFIDENCE || sb < MIN_CONFIDENCE) continue;

    const ay = Number(a[i * 3]);
    const ax = Number(a[i * 3 + 1]);
    const by = Number(b[i * 3]);
    const bx = Number(b[i * 3 + 1]);

    dot += ax * bx + ay * by;
    na += ax * ax + ay * ay;
    nb += bx * bx + by * by;
    used += 1;
  }

  // 공통으로 잡힌 키포인트가 너무 적으면 신뢰 불가
  if (used < 6 || na < 1e-6 || nb < 1e-6) return -1;

  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  // 코사인 [-1,1] → [0,1]로 변환 후, 차이를 더 민감하게 보이도록 제곱
  const score = Math.max(0, (cos + 1) / 2);
  return score * score;
}

/** 자동 셔터 발동 임계치 */
export const SHUTTER_THRESHOLD = 0.92;
/** 임계치 이상을 유지해야 하는 시간 (ms) */
export const SHUTTER_HOLD_MS = 600;
/** 촬영 후 재발동 금지 시간 (ms) */
export const SHUTTER_COOLDOWN_MS = 3000;
