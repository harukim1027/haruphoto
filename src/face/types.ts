// Apple Vision 프레임프로세서('detectFace')가 프레임당 돌려주는 원시 결과
export interface FaceVisionResult {
  found: boolean;
  mirrored?: boolean;
  // 구도 (정규화 0~1, 화면 상단 기준)
  x?: number;
  y?: number;
  size?: number;
  // 각도 (radian)
  yaw?: number;
  pitch?: number;
  roll?: number;
  // 표정 근사 (0~1)
  mouthOpen?: number;
  smile?: number;
  leftEyeOpen?: number;
  rightEyeOpen?: number;
  // 시선 근사 (0~1, 0.5=중앙)
  gazeX?: number;
  gazeY?: number;
}

// 매칭에 쓰는 정리된 얼굴 특징
export interface FaceFeatures {
  framing: { cx: number; cy: number; size: number };
  orientation: { yaw: number; pitch: number; roll: number };
  expression: {
    mouthOpen: number;
    smile: number;
    leftEyeOpen: number;
    rightEyeOpen: number;
  };
  gaze: { x: number; y: number };
}

/**
 * 원시 결과 → FaceFeatures. 전면 카메라(mirrored)면 yaw/roll/gazeX 좌우 반전 보정.
 * (인수인계 2-7: front/back 별 좌우 분기)
 */
export function toFaceFeatures(r: FaceVisionResult): FaceFeatures | null {
  'worklet';
  if (!r || !r.found) return null;
  const mir = r.mirrored ? -1 : 1;
  return {
    framing: {
      cx: r.mirrored ? 1 - (r.x ?? 0.5) : r.x ?? 0.5,
      cy: r.y ?? 0.5,
      size: r.size ?? 0,
    },
    orientation: {
      yaw: (r.yaw ?? 0) * mir,
      pitch: r.pitch ?? 0,
      roll: (r.roll ?? 0) * mir,
    },
    expression: {
      mouthOpen: r.mouthOpen ?? 0,
      smile: r.smile ?? 0,
      leftEyeOpen: r.leftEyeOpen ?? 0,
      rightEyeOpen: r.rightEyeOpen ?? 0,
    },
    gaze: {
      x: r.mirrored ? 1 - (r.gazeX ?? 0.5) : r.gazeX ?? 0.5,
      y: r.gazeY ?? 0.5,
    },
  };
}
