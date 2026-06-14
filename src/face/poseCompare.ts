import type { PoseJoints } from './types';

// 자세 비교/분석 — 시각 가이드(어긋난 관절 강조)가 주, 문구는 보조.
// 모든 계산은 "어깨중점 원점 + 어깨너비 스케일" 정규화 공간에서 한다.
// → 사람이 어디에 서 있든(위치/크기 무관) 자세의 '모양'만 비교한다.
// (회전·기울기는 보존하므로 어깨/몸통 기울기 차이는 그대로 잡힌다.)

export type PartKey = 'leftArm' | 'rightArm' | 'shoulders' | 'torso' | 'head';

export const PART_LABEL: Record<PartKey, string> = {
  leftArm: '왼팔',
  rightArm: '오른팔',
  shoulders: '어깨',
  torso: '몸통',
  head: '고개',
};

// 부위 → 색으로 강조할 관절들
export const PART_JOINTS: Record<PartKey, (keyof PoseJoints)[]> = {
  leftArm: ['leftElbow', 'leftWrist'],
  rightArm: ['rightElbow', 'rightWrist'],
  shoulders: ['leftShoulder', 'rightShoulder'],
  torso: ['root'],
  head: ['neck'],
};

// 부위별 일치 허용오차(어깨너비 단위). 작을수록 엄격.
const PART_TOL: Record<PartKey, number> = {
  leftArm: 0.5,
  rightArm: 0.5,
  shoulders: 0.28,
  torso: 0.4,
  head: 0.4,
};
// 관절 점 하나의 일치 허용오차(색 표시용)
const JOINT_TOL = 0.5;

type XY = { x: number; y: number };
export type JMap = Partial<Record<keyof PoseJoints, XY>>;

const ALL_KEYS: (keyof PoseJoints)[] = [
  'neck',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'root',
];

interface Norm {
  n: JMap;
  ox: number;
  oy: number;
  w: number;
}

// 어깨중점 원점 + 어깨너비 스케일 정규화. 어깨가 둘 다 있어야 가능.
function normalize(j: JMap): Norm | null {
  const lS = j.leftShoulder;
  const rS = j.rightShoulder;
  if (!lS || !rS) return null;
  const ox = (lS.x + rS.x) / 2;
  const oy = (lS.y + rS.y) / 2;
  const w = Math.hypot(rS.x - lS.x, rS.y - lS.y) || 1e-3;
  const n: JMap = {};
  for (const k of ALL_KEYS) {
    const p = j[k];
    if (p) n[k] = { x: (p.x - ox) / w, y: (p.y - oy) / w };
  }
  return { n, ox, oy, w };
}

function dist(a?: XY, b?: XY): number | null {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface PoseComparison {
  parts: Record<PartKey, { present: boolean; dist: number; ok: boolean }>;
  jointOk: Partial<Record<keyof PoseJoints, boolean>>; // 관절별 일치(초록) 여부
  worst: PartKey | null; // 가장 많이 어긋난 부위
  guide: string; // 보조 문구(가장 어긋난 부위 1개)
  allMatched: boolean; // 핵심 부위 전부 일치 → "자세 완성"
  target: JMap; // 라이브 어깨프레임에 앉힌 레퍼런스(고스트, 입력 liveJ와 동일 좌표계)
}

/**
 * 레퍼런스(refJ)와 내 현재(liveJ) 자세 비교.
 * 두 입력은 같은 좌표계일 필요 없음(각자 어깨 기준으로 정규화). 단,
 * target(고스트)은 liveJ 좌표계로 돌려주므로 liveJ를 '화면 픽셀'로 주면 화면에 바로 그린다.
 */
export function comparePose(refJ: JMap, liveJ: JMap): PoseComparison | null {
  const rN = normalize(refJ);
  const lN = normalize(liveJ);
  if (!rN) return null; // 레퍼런스에 어깨가 없으면 자세 비교 불가

  // 고스트 타깃: 레퍼런스 정규화 자세를 내 어깨프레임에 앉힌다(=내 몸 위에 목표 표시).
  const target: JMap = {};
  if (lN) {
    for (const k of ALL_KEYS) {
      const p = rN.n[k];
      if (p) target[k] = { x: lN.ox + p.x * lN.w, y: lN.oy + p.y * lN.w };
    }
  }

  // 관절별 정규화 거리 → 일치 여부
  const jointOk: Partial<Record<keyof PoseJoints, boolean>> = {};
  const jd: Partial<Record<keyof PoseJoints, number>> = {};
  if (lN) {
    for (const k of ALL_KEYS) {
      const d = dist(rN.n[k], lN.n[k]);
      if (d != null) {
        jd[k] = d;
        jointOk[k] = d <= JOINT_TOL;
      }
    }
  }

  // 부위별 거리/일치
  const parts = {} as PoseComparison['parts'];
  for (const part of Object.keys(PART_JOINTS) as PartKey[]) {
    const ks = PART_JOINTS[part];
    const ds = ks.map((k) => jd[k]).filter((d): d is number => d != null);
    if (ds.length === 0) {
      parts[part] = { present: false, dist: 0, ok: false };
    } else {
      const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
      parts[part] = { present: true, dist: avg, ok: avg <= PART_TOL[part] };
    }
  }

  // 가장 많이 어긋난 부위(허용오차 초과분이 가장 큰 것)
  let worst: PartKey | null = null;
  let worstOver = 0;
  for (const part of Object.keys(parts) as PartKey[]) {
    const p = parts[part];
    if (!p.present || p.ok) continue;
    const over = p.dist - PART_TOL[part];
    if (over > worstOver) {
      worstOver = over;
      worst = part;
    }
  }

  // 핵심 부위(존재하는 것) 전부 일치 → 완성. 어깨+팔 하나 이상은 보여야 인정.
  const presentParts = (Object.keys(parts) as PartKey[]).filter(
    (p) => parts[p].present,
  );
  const enough =
    parts.shoulders.present &&
    (parts.leftArm.present || parts.rightArm.present);
  const allMatched =
    enough && presentParts.length > 0 && presentParts.every((p) => parts[p].ok);

  const guide = worst ? guideFor(worst, rN.n, lN?.n) : '자세 완성!';
  return { parts, jointOk, worst, guide, allMatched, target };
}

// 어긋난 부위 1개에 대한 한국어 코칭(보조). y는 아래로 증가(top-left/화면).
function guideFor(part: PartKey, ref: JMap, live?: JMap): string {
  if (!live) return `${PART_LABEL[part]}을 사진처럼 맞춰요`;
  if (part === 'leftArm' || part === 'rightArm') {
    const wKey = part === 'leftArm' ? 'leftWrist' : 'rightWrist';
    const eKey = part === 'leftArm' ? 'leftElbow' : 'rightElbow';
    const r = ref[wKey] ?? ref[eKey];
    const l = live[wKey] ?? live[eKey];
    const label = PART_LABEL[part];
    if (!r || !l) return `${label}을 사진처럼 맞춰요`;
    const dx = l.x - r.x;
    const dy = l.y - r.y;
    if (Math.abs(dy) >= Math.abs(dx)) {
      return dy > 0 ? `${label}을 더 올리세요` : `${label}을 내리세요`;
    }
    return dx > 0 ? `${label}을 안쪽으로` : `${label}을 바깥쪽으로`;
  }
  if (part === 'shoulders') {
    // 어깨선 기울기: 정규화 좌표에서 오른어깨 y - 왼어깨 y 의 부호 비교.
    const rt = (ref.rightShoulder?.y ?? 0) - (ref.leftShoulder?.y ?? 0);
    const lt = (live.rightShoulder?.y ?? 0) - (live.leftShoulder?.y ?? 0);
    return lt > rt ? '어깨를 왼쪽으로 기울여요' : '어깨를 오른쪽으로 기울여요';
  }
  if (part === 'torso') {
    const r = ref.root;
    const l = live.root;
    if (r && l && Math.abs(l.x - r.x) > 0.12) {
      return l.x > r.x ? '몸을 왼쪽으로 기울여요' : '몸을 오른쪽으로 기울여요';
    }
    return '몸을 사진처럼 세워요';
  }
  // head (neck)
  const r = ref.neck;
  const l = live.neck;
  if (r && l) {
    if (Math.abs(l.x - r.x) >= Math.abs(l.y - r.y)) {
      return l.x > r.x ? '고개를 오른쪽으로' : '고개를 왼쪽으로';
    }
    return l.y > r.y ? '고개를 드세요' : '고개를 살짝 숙여요';
  }
  return '고개를 사진처럼 맞춰요';
}

/**
 * 레퍼런스 자세를 사람이 읽을 수 있는 한 줄 요약으로(사진 선택 시 1회).
 * 예: "왼팔을 들어 머리 옆, 오른팔은 내림 · 어깨 수평".
 */
export function summarizePose(pose?: PoseJoints): string | null {
  if (!pose) return null;
  const rN = normalize(pose as JMap);
  if (!rN) return null;
  const n = rN.n;

  const armPhrase = (side: 'left' | 'right'): string | null => {
    const label = side === 'left' ? '왼팔' : '오른팔';
    const wrist = n[`${side}Wrist` as keyof PoseJoints];
    const elbow = n[`${side}Elbow` as keyof PoseJoints];
    const tip = wrist ?? elbow;
    if (!tip) return null;
    // y < 0 : 어깨보다 위(들었다). 작을수록 높이 들었다.
    if (tip.y < -0.9) {
      return Math.abs(tip.x) < 0.5
        ? `${label}을 들어 머리 위`
        : `${label}을 높이 들어`;
    }
    if (tip.y < -0.25) {
      // 손목이 머리/얼굴 쪽(안쪽, x가 중앙쪽)인지
      const inward =
        (side === 'left' && tip.x > -0.3) || (side === 'right' && tip.x < 0.3);
      return inward ? `${label}을 들어 얼굴 옆` : `${label}을 옆으로 들어`;
    }
    if (tip.y < 0.6) return `${label}은 가볍게`;
    return `${label}은 내림`;
  };

  const parts: string[] = [];
  const la = armPhrase('left');
  const ra = armPhrase('right');
  if (la) parts.push(la);
  if (ra) parts.push(ra);

  // 어깨선 기울기
  const lS = n.leftShoulder;
  const rS = n.rightShoulder;
  if (lS && rS) {
    const tilt = rS.y - lS.y; // +면 오른어깨가 아래
    if (Math.abs(tilt) > 0.12) {
      parts.push(tilt > 0 ? '오른쪽 어깨가 내려감' : '왼쪽 어깨가 내려감');
    } else {
      parts.push('어깨 수평');
    }
  }

  // 몸통 기울기(목→골반)
  const neck = n.neck;
  const root = n.root;
  if (neck && root) {
    const lean = root.x - neck.x;
    if (Math.abs(lean) > 0.18) {
      parts.push(lean > 0 ? '몸을 왼쪽으로 기울임' : '몸을 오른쪽으로 기울임');
    }
  }

  return parts.length ? parts.join(' · ') : null;
}
