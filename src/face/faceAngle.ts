// 얼굴 각도(고개 방향) 분석/비교. yaw/pitch/roll 은 radian.
// 입력 각도는 이미 mirror 보정된 값(toFaceFeatures 에서 전면이면 yaw/roll ×-1)이라
// 레퍼런스(미보정)와 동일 화면 공간에서 비교된다 → 좌우 반대로 안내되지 않음.
// 방향 부호 규약은 기존 guide.ts(orientation) 와 동일하게 맞춘다.

export interface FaceAngles {
  yaw: number;
  pitch: number;
  roll: number;
}

// 허용오차(radian). ~0.16rad ≈ 9°.
export const FACE_TOL = { yaw: 0.16, pitch: 0.16, roll: 0.14 };

export type FaceAxis = 'yaw' | 'pitch' | 'roll';

export interface FaceCompare {
  dyaw: number; // live - ref
  dpitch: number;
  droll: number;
  yawOk: boolean;
  pitchOk: boolean;
  rollOk: boolean;
  ok: boolean; // 세 축 모두 허용 내
  worst: FaceAxis | null; // 가장 많이 어긋난 축
  guide: string; // 보조 문구(가장 어긋난 축 1개)
}

export function compareFace(ref: FaceAngles, live: FaceAngles): FaceCompare {
  const dyaw = live.yaw - ref.yaw;
  const dpitch = live.pitch - ref.pitch;
  const droll = live.roll - ref.roll;
  const yawOk = Math.abs(dyaw) <= FACE_TOL.yaw;
  const pitchOk = Math.abs(dpitch) <= FACE_TOL.pitch;
  const rollOk = Math.abs(droll) <= FACE_TOL.roll;
  const ok = yawOk && pitchOk && rollOk;

  // 허용오차 초과분이 가장 큰 축
  const over: Record<FaceAxis, number> = {
    yaw: Math.abs(dyaw) - FACE_TOL.yaw,
    pitch: Math.abs(dpitch) - FACE_TOL.pitch,
    roll: Math.abs(droll) - FACE_TOL.roll,
  };
  let worst: FaceAxis | null = null;
  let m = 0;
  (['yaw', 'pitch', 'roll'] as FaceAxis[]).forEach((k) => {
    if (over[k] > m) {
      m = over[k];
      worst = k;
    }
  });

  let guide = '고개 각도 좋아요';
  if (worst === 'yaw') {
    guide = dyaw > 0 ? '고개를 오른쪽으로 돌리세요' : '고개를 왼쪽으로 돌리세요';
  } else if (worst === 'pitch') {
    guide = dpitch > 0 ? '턱을 살짝 내리세요' : '턱을 살짝 드세요';
  } else if (worst === 'roll') {
    guide = droll > 0 ? '고개를 왼쪽으로 갸웃' : '고개를 오른쪽으로 갸웃';
  }
  return { dyaw, dpitch, droll, yawOk, pitchOk, rollOk, ok, worst, guide };
}

/**
 * 레퍼런스 얼굴 각도를 사람이 읽을 수 있는 요약으로(사진 선택 시 1회).
 * 예: "고개를 살짝 왼쪽으로, 턱을 약간 내려".
 */
export function summarizeFace(o: FaceAngles): string {
  const parts: string[] = [];
  if (o.yaw > 0.12) parts.push('고개를 왼쪽으로 돌림');
  else if (o.yaw < -0.12) parts.push('고개를 오른쪽으로 돌림');
  if (o.pitch > 0.12) parts.push('턱을 든 편');
  else if (o.pitch < -0.12) parts.push('턱을 내린 편');
  if (o.roll > 0.1) parts.push('고개를 갸웃');
  else if (o.roll < -0.1) parts.push('반대로 갸웃');
  return parts.length ? parts.join(', ') : '정면';
}
