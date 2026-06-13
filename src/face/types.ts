export interface Pt {
  x: number;
  y: number;
}

// Apple Vision('detectFace'/'FaceVision')이 돌려주는 원시 결과
export interface FaceVisionResult {
  found: boolean;
  mirrored?: boolean;
  // 구도 (정규화 0~1, 화면 상단 기준)
  x?: number;
  y?: number;
  size?: number;
  // bbox (top-left 정규화)
  bx?: number;
  by?: number;
  bw?: number;
  bh?: number;
  // 이미지 upright 크기 (cover 매핑용)
  imgW?: number;
  imgH?: number;
  // 각도 (radian)
  yaw?: number;
  pitch?: number;
  roll?: number;
  // 표정 근사 (0~1)
  mouthOpen?: number;
  smile?: number;
  leftEyeOpen?: number;
  rightEyeOpen?: number;
  // 시선 근사 (0~1)
  gazeX?: number;
  gazeY?: number;
  // 검증/오버레이용 랜드마크 점 (top-left 정규화 이미지 좌표)
  points?: {
    leftEye?: Pt;
    rightEye?: Pt;
    nose?: Pt;
    mouth?: Pt;
  };
  // 상체 박스 (top-left 정규화) — 자세/프레이밍용
  body?: { x: number; y: number; w: number; h: number };
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
  // 자세: 상체 박스(중심/크기, mirror 보정됨). 반신 셀카면 존재, 얼굴만이면 undefined.
  body?: { cx: number; cy: number; w: number; h: number };
  // 오버레이용 (정규화 top-left 이미지 좌표). 매칭에는 안 씀.
  imageSize?: { w: number; h: number };
  bbox?: { x: number; y: number; w: number; h: number };
  bodyBox?: { x: number; y: number; w: number; h: number }; // top-left (오버레이)
  landmarks?: { leftEye?: Pt; rightEye?: Pt; nose?: Pt; mouth?: Pt };
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
    body: r.body
      ? {
          cx: r.mirrored
            ? 1 - (r.body.x + r.body.w / 2)
            : r.body.x + r.body.w / 2,
          cy: r.body.y + r.body.h / 2,
          w: r.body.w,
          h: r.body.h,
        }
      : undefined,
    imageSize: r.imgW && r.imgH ? { w: r.imgW, h: r.imgH } : undefined,
    bbox:
      r.bx != null
        ? { x: r.bx, y: r.by ?? 0, w: r.bw ?? 0, h: r.bh ?? 0 }
        : undefined,
    bodyBox: r.body
      ? { x: r.body.x, y: r.body.y, w: r.body.w, h: r.body.h }
      : undefined,
    landmarks: r.points,
  };
}

/**
 * 정규화 top-left 이미지 좌표 → resizeMode="cover" 컨테이너 화면 좌표.
 * cover 는 컨테이너를 꽉 채우며 넘치는 부분을 자르므로, 표시된 이미지 기준으로 변환해야 한다.
 */
export function mapCover(
  nx: number,
  ny: number,
  imgW: number,
  imgH: number,
  contW: number,
  contH: number,
): Pt {
  const scale = Math.max(contW / imgW, contH / imgH);
  const dispW = imgW * scale;
  const dispH = imgH * scale;
  const offX = (contW - dispW) / 2;
  const offY = (contH - dispH) / 2;
  return { x: offX + nx * dispW, y: offY + ny * dispH };
}
