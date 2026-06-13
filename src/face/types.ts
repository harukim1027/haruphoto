export interface Pt {
  x: number;
  y: number;
}
export interface Joint {
  x: number;
  y: number;
  c: number; // confidence
}
export interface PoseJoints {
  neck?: Joint;
  leftShoulder?: Joint;
  rightShoulder?: Joint;
  leftElbow?: Joint;
  rightElbow?: Joint;
  leftWrist?: Joint;
  rightWrist?: Joint;
  root?: Joint;
}

// Apple Vision('detectFace'/'FaceVision') 원시 결과
export interface FaceVisionResult {
  found: boolean;
  noFace?: boolean; // 얼굴 없이 상체 포즈만
  mirrored?: boolean;
  x?: number;
  y?: number;
  size?: number;
  bx?: number;
  by?: number;
  bw?: number;
  bh?: number;
  imgW?: number;
  imgH?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  mouthOpen?: number;
  smile?: number;
  leftEyeOpen?: number;
  rightEyeOpen?: number;
  gazeX?: number;
  gazeY?: number;
  points?: { leftEye?: Pt; rightEye?: Pt; nose?: Pt; mouth?: Pt };
  pose?: PoseJoints; // 상체 관절 (top-left 정규화)
}

// 매칭/표시에 쓰는 정리된 특징
export interface FaceFeatures {
  hasFace: boolean;
  hasPose: boolean;
  framing: { cx: number; cy: number; size: number };
  orientation: { yaw: number; pitch: number; roll: number };
  expression: {
    mouthOpen: number;
    smile: number;
    leftEyeOpen: number;
    rightEyeOpen: number;
  };
  gaze: { x: number; y: number };
  pose?: PoseJoints; // mirror 보정된 상체 관절 (top-left 정규화) — 매칭·오버레이용
  // 얼굴 오버레이용 (정규화 top-left 이미지 좌표)
  imageSize?: { w: number; h: number };
  bbox?: { x: number; y: number; w: number; h: number };
  landmarks?: { leftEye?: Pt; rightEye?: Pt; nose?: Pt; mouth?: Pt };
}

// 전면(미러)일 때 관절 좌우 반전 + 좌/우 라벨 스왑
function mirrorPose(p: PoseJoints): PoseJoints {
  'worklet';
  const fx = (j?: Joint): Joint | undefined =>
    j ? { x: 1 - j.x, y: j.y, c: j.c } : undefined;
  return {
    neck: fx(p.neck),
    root: fx(p.root),
    leftShoulder: fx(p.rightShoulder),
    rightShoulder: fx(p.leftShoulder),
    leftElbow: fx(p.rightElbow),
    rightElbow: fx(p.leftElbow),
    leftWrist: fx(p.rightWrist),
    rightWrist: fx(p.leftWrist),
  };
}

/**
 * 원시 결과 → FaceFeatures. 전면(mirrored)이면 좌우 반전 보정(얼굴 + 포즈).
 */
export function toFaceFeatures(r: FaceVisionResult): FaceFeatures | null {
  'worklet';
  if (!r || !r.found) return null;
  const mir = r.mirrored ? -1 : 1;
  const hasFace = !r.noFace;
  const pose = r.pose
    ? r.mirrored
      ? mirrorPose(r.pose)
      : r.pose
    : undefined;

  return {
    hasFace,
    hasPose: !!pose,
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
    pose,
    imageSize: r.imgW && r.imgH ? { w: r.imgW, h: r.imgH } : undefined,
    bbox:
      r.bx != null
        ? { x: r.bx, y: r.by ?? 0, w: r.bw ?? 0, h: r.bh ?? 0 }
        : undefined,
    landmarks: r.points,
  };
}

/**
 * 정규화 top-left 이미지 좌표 → resizeMode="cover" 컨테이너 화면 좌표.
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

// 상체 스켈레톤 연결선 (그리기용)
export const POSE_EDGES: [keyof PoseJoints, keyof PoseJoints][] = [
  ['leftShoulder', 'rightShoulder'],
  ['neck', 'leftShoulder'],
  ['neck', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['neck', 'root'],
];
