import type { Pt } from './types';

// 실루엣 폴리곤(이미지 정규화 top-left)을 '인물 바운딩박스' 기준 단위정사각형(0~1)으로
// 정규화. 가로세로 비율을 보존(픽셀 종횡비 반영)하고 중앙 정렬한다.
// → 레퍼런스/라이브를 같은 좌표계로 맞춰 화면에 앉히고 IoU 비교가 가능.
export function normalizeSilhouette(
  poly: Pt[] | undefined | null,
  imgW: number,
  imgH: number,
): Pt[] | null {
  'worklet';
  if (!poly || poly.length < 3 || imgW <= 0 || imgH <= 0) return null;
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1e9;
  let maxY = -1e9;
  for (const p of poly) {
    const px = p.x * imgW;
    const py = p.y * imgH;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  const s = Math.max(bw, bh);
  const offU = (1 - bw / s) / 2;
  const offV = (1 - bh / s) / 2;
  return poly.map((p) => ({
    x: (p.x * imgW - minX) / s + offU,
    y: (p.y * imgH - minY) / s + offV,
  }));
}

function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  'worklet';
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// 두 단위정사각형 실루엣의 IoU(교집합/합집합). 그리드 래스터화.
export function silhouetteIoU(
  a: Pt[] | null,
  b: Pt[] | null,
  n = 40,
): number {
  'worklet';
  if (!a || !b || a.length < 3 || b.length < 3) return 0;
  let inter = 0;
  let uni = 0;
  for (let j = 0; j < n; j++) {
    const cy = (j + 0.5) / n;
    for (let i = 0; i < n; i++) {
      const cx = (i + 0.5) / n;
      const ina = pointInPoly(cx, cy, a);
      const inb = pointInPoly(cx, cy, b);
      if (ina || inb) uni++;
      if (ina && inb) inter++;
    }
  }
  return uni === 0 ? 0 : inter / uni;
}

// 단위정사각형 좌표 → 화면 픽셀(고정 타깃 사각 영역). 위치/크기 가이드.
export function placeUnit(
  unit: Pt[] | null,
  W: number,
  H: number,
): Pt[] | null {
  if (!unit) return null;
  const side = Math.min(W * 0.92, H * 0.62);
  const ox = (W - side) / 2;
  const oy = H * 0.14;
  return unit.map((p) => ({ x: ox + p.x * side, y: oy + p.y * side }));
}

// 실루엣 매칭(IoU) 양호 임계 — IoU는 0.6 이상이면 상당히 겹친 것.
export const POSE_IOU_GOOD = 0.55;
