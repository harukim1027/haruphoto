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

// 이미지 정규화 top-left 점들 → resizeMode="cover" 화면 정규화 [0,1].
// 레퍼런스/라이브를 같은 화면 좌표계로 매핑(실제 구도 위치 보존) → 겹침(IoU) 직관적.
export function coverUnit(
  pts: Pt[] | null | undefined,
  imgW: number,
  imgH: number,
  W: number,
  H: number,
  contain = false, // true면 contain(전체 표시, 레터박스) — Camera resizeMode 와 일치시킬 것
): Pt[] | null {
  'worklet';
  if (!pts || pts.length < 3 || imgW <= 0 || imgH <= 0 || W <= 0 || H <= 0)
    return null;
  const scale = contain
    ? Math.min(W / imgW, H / imgH)
    : Math.max(W / imgW, H / imgH);
  const dW = imgW * scale;
  const dH = imgH * scale;
  const offX = (W - dW) / 2;
  const offY = (H - dH) / 2;
  return pts.map((p) => ({
    x: (offX + p.x * dW) / W,
    y: (offY + p.y * dH) / H,
  }));
}

// 단일 점 매핑(얼굴 가이드/점). 화면 정규화 [0,1].
export function coverPoint(
  x: number,
  y: number,
  imgW: number,
  imgH: number,
  W: number,
  H: number,
  contain = false,
): Pt {
  'worklet';
  const scale = contain
    ? Math.min(W / imgW, H / imgH)
    : Math.max(W / imgW, H / imgH);
  const dW = imgW * scale;
  const dH = imgH * scale;
  return { x: ((W - dW) / 2 + x * dW) / W, y: ((H - dH) / 2 + y * dH) / H };
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

// ── 구도(framing): 인물 실루엣 bbox 로 계산 ──
// 얼굴 bbox(라이브에서 자주 noFace)에 의존하지 않고, 안정적인 실루엣의 bbox 사용.
// 입력은 같은 화면정규화 공간(coverUnit 결과)이라 ref/live 가 직접 비교된다.
export interface UBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  size: number;
}
export function unitBBox(pts: Pt[] | null | undefined): UBox | null {
  'worklet';
  if (!pts || pts.length < 3) return null;
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1e9;
  let maxY = -1e9;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h, size: Math.max(w, h) };
}

// 구도 허용오차(화면 정규화). 조정 가능.
export const FRAMING_TOL = { pos: 0.18, size: 0.28 };

export interface FramingResult {
  score: number;
  dpos: number;
  dsize: number;
  ref: UBox | null;
  live: UBox | null;
}
export function framingFromUnits(
  ref: Pt[] | null,
  live: Pt[] | null,
): FramingResult {
  'worklet';
  const a = unitBBox(ref);
  const b = unitBBox(live);
  if (!a || !b) return { score: 0, dpos: 1, dsize: 1, ref: a, live: b };
  const dpos = Math.hypot(a.cx - b.cx, a.cy - b.cy);
  const dsize = Math.abs(a.size - b.size) / Math.max(a.size, 0.01);
  const sc =
    (Math.max(0, Math.min(1, 1 - dpos / FRAMING_TOL.pos)) +
      Math.max(0, Math.min(1, 1 - dsize / FRAMING_TOL.size))) /
    2;
  return { score: sc, dpos, dsize, ref: a, live: b };
}

// 구도 보정 방향(한 줄). 거리(크기) 우선 → 위치. 차이 작으면 빈 문자열.
export function framingGuide(fr: FramingResult): string {
  'worklet';
  if (!fr.ref || !fr.live) return '';
  if (fr.dsize > 0.18) return fr.live.size < fr.ref.size ? '조금 더 가까이' : '조금 더 멀리';
  if (fr.dpos > 0.12) {
    const dy = fr.live.cy - fr.ref.cy;
    const dx = fr.live.cx - fr.ref.cx;
    if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? '조금 위로' : '조금 아래로';
    return dx > 0 ? '살짝 왼쪽으로' : '살짝 오른쪽으로';
  }
  return '';
}

// 행-스캔 실루엣(앞 절반=왼쪽 모서리 위→아래, 뒤 절반=오른쪽 아래→위)의 x를
// 각 모서리별 이동평균으로 부드럽게. 들쭉날쭉(머리카락/팔/노이즈) 제거.
export function smoothEdges(pts: Pt[] | null, win = 4): Pt[] | null {
  if (!pts || pts.length < 6) return pts;
  const L = Math.floor(pts.length / 2);
  const avg = (arr: Pt[]) =>
    arr.map((p, i) => {
      let sx = 0;
      let n = 0;
      for (let k = -win; k <= win; k++) {
        const j = i + k;
        if (j >= 0 && j < arr.length) {
          sx += arr[j].x;
          n++;
        }
      }
      return { x: sx / n, y: p.y };
    });
  return [...avg(pts.slice(0, L)), ...avg(pts.slice(L))];
}

// 화면 픽셀 점들 → SVG <Polygon> points 문자열(직선, 디테일 보존).
// 레퍼런스/촬영이 '같은 방식'으로 그리도록 공통 사용.
export function svgPolyPoints(pts: Pt[] | null | undefined): string | null {
  if (!pts || pts.length < 3) return null;
  let s = '';
  for (const p of pts) s += `${p.x.toFixed(1)},${p.y.toFixed(1)} `;
  return s.trim();
}

// 실루엣 표시용 공통 스무딩 강도(레퍼런스/촬영 동일하게). 너무 높이면 뭉개짐.
export const SILHOUETTE_SMOOTH_WIN = 2;

// 점들을 부드러운 닫힌 곡선(2차 베지어, 중점 통과) SVG path d 로.
export function toSmoothPathD(pts: Pt[] | null): string | null {
  if (!pts || pts.length < 3) return null;
  const n = pts.length;
  const mx = (a: Pt, b: Pt) => (a.x + b.x) / 2;
  const my = (a: Pt, b: Pt) => (a.y + b.y) / 2;
  let d = `M ${mx(pts[n - 1], pts[0]).toFixed(1)} ${my(pts[n - 1], pts[0]).toFixed(1)} `;
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const nxt = pts[(i + 1) % n];
    d += `Q ${cur.x.toFixed(1)} ${cur.y.toFixed(1)} ${mx(cur, nxt).toFixed(1)} ${my(cur, nxt).toFixed(1)} `;
  }
  return d + 'Z';
}
