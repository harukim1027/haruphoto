import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  VisionCameraProxy,
  type CameraDevice,
  type CameraPosition,
} from 'react-native-vision-camera';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Worklets, useSharedValue } from 'react-native-worklets-core';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import {
  toFaceFeatures,
  POSE_EDGES,
  type FaceVisionResult,
  type PoseJoints,
  type Pt,
} from '../face/types';
import { matchFace, MATCH_THRESHOLD, type MatchScores } from '../face/matchFace';
import { guideText } from '../face/guide';
import {
  comparePose,
  summarizePose,
  PART_LABEL,
  type JMap,
  type PartKey,
  type PoseComparison,
} from '../face/poseCompare';
import { createLiveSmoother } from '../face/smooth';
import { compareFace, summarizeFace, type FaceCompare } from '../face/faceAngle';
import {
  silhouetteIoU,
  coverUnit,
  coverPoint,
  svgPolyPoints,
  framingFromUnits,
  framingGuide,
  unitBBox,
  type FramingResult,
  POSE_IOU_GOOD,
} from '../face/silhouette';
import Svg, {
  Polygon,
  Ellipse,
  Line as SvgLine,
  Circle as SvgCircle,
} from 'react-native-svg';

// 관절(이미지 정규화) → 화면 픽셀. 미리보기와 동일 매핑(front=contain).
// flipY: 라이브 포즈는 검출 방향(right)이 display(primary)와 180° 달라 y 반전 필요.
function poseToScreen(
  pose: PoseJoints | undefined,
  imgW: number,
  imgH: number,
  W: number,
  H: number,
  contain: boolean,
  flipY = false,
): Partial<Record<keyof PoseJoints, Pt>> {
  const out: Partial<Record<keyof PoseJoints, Pt>> = {};
  if (!pose) return out;
  const scale = contain
    ? Math.min(W / imgW, H / imgH)
    : Math.max(W / imgW, H / imgH);
  const dW = imgW * scale;
  const dH = imgH * scale;
  const offX = (W - dW) / 2;
  const offY = (H - dH) / 2;
  for (const k of Object.keys(pose) as (keyof PoseJoints)[]) {
    const j = pose[k];
    if (j && j.c > 0.05) {
      const jy = flipY ? 1 - j.y : j.y;
      out[k] = { x: offX + j.x * dW, y: offY + jy * dH };
    }
  }
  return out;
}
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Shoot'>;
type Rt = RouteProp<RootStackParamList, 'Shoot'>;

const facePlugin = VisionCameraProxy.initFrameProcessorPlugin('detectFace', {});

// 후면 줌 프리셋(실제 렌즈 기반).
const ZOOM_PRESETS = [0.5, 0.6, 0.8, 1, 1.5, 2];
// 전면: 73.7° 풀FOV 가 기본 카메라 "0.5x". 라벨 → zoom 배수(neutralZoom 기준) 매핑.
//   0.5x=풀FOV(유지). 기본 카메라 0.5x:1x 화각비 ≈ 1.4~1.5배라 1x=1.45, 2x=2.9.
//   실기기 비교 후 미세조정: 1x가 크면 1.45→1.3, 작으면 1.6.
const FRONT_ZOOM_MAP: { label: number; mul: number }[] = [
  { label: 0.5, mul: 1.0 },
  { label: 1, mul: 1.45 },
  { label: 2, mul: 2.9 },
];
const clamp = (z: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, z));
// 전면 라벨 → 실제 zoom (min~max clamp)
function frontZoom(label: number, dev: CameraDevice): number {
  const m = FRONT_ZOOM_MAP.find((e) => e.label === label)?.mul ?? 1;
  return clamp(dev.neutralZoom * m, dev.minZoom, dev.maxZoom);
}
// 현재 zoom 에 가장 가까운 전면 라벨(하이라이트용)
function frontActiveLabel(z: number, dev: CameraDevice): number {
  let best = FRONT_ZOOM_MAP[0];
  let bestD = Infinity;
  for (const e of FRONT_ZOOM_MAP) {
    const d = Math.abs(frontZoom(e.label, dev) - z);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best.label;
}
function displayToZoom(d: number, dev: CameraDevice): number {
  const z =
    d >= 1
      ? dev.neutralZoom * d
      : dev.minZoom + ((d - 0.5) / 0.5) * (dev.neutralZoom - dev.minZoom);
  return clamp(z, dev.minZoom, dev.maxZoom);
}
function zoomToDisplay(z: number, dev: CameraDevice): number {
  if (z >= dev.neutralZoom) return z / dev.neutralZoom;
  if (dev.neutralZoom <= dev.minZoom + 1e-3) return 1;
  return 0.5 + ((z - dev.minZoom) / (dev.neutralZoom - dev.minZoom)) * 0.5;
}
function presetAvailable(d: number, dev: CameraDevice): boolean {
  if (d < 1) return dev.minZoom < dev.neutralZoom * 0.97;
  if (d > 1) return dev.neutralZoom * d <= dev.maxZoom * 1.02;
  return true;
}

const ZERO: MatchScores = {
  pose: 0,
  framing: 0,
  expression: 0,
  gaze: 0,
  orientation: 0,
  hasPose: false,
  overall: 0,
};

interface LiveData {
  bodyOutline?: Pt[]; // un-mirror 보정된 몸 실루엣 (이미지 정규화)
  pose?: PoseJoints; // un-mirror 보정된 상체 관절
  iou: number; // 레퍼런스 실루엣과의 겹침(주력 매칭)
  cx: number;
  cy: number;
  size: number;
  fw: number;
  fh: number;
  yaw: number; // 얼굴 각도(mirror 보정, radian)
  pitch: number;
  roll: number;
  face: boolean; // 이 프레임에 실제 얼굴이 있었는지(각도 유효성)
}

// 매 프레임 검출 상태(얼굴이 안 잡혀도 항상 갱신) — 진단용
interface Diag {
  found: boolean;
  noFace: boolean;
  contourN: number;
  poseN: number;
  poseObs: number;
  poseRaw: number;
  poseOri: string;
  silN: number;
  fw: number;
  fh: number;
}

export default function ShootScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { referenceUri, referenceFeatures } = route.params;
  const { width: W, height: H } = useWindowDimensions();

  const [position, setPosition] = useState<CameraPosition>('front');
  const device = useCameraDevice(position, {
    physicalDevices: [
      'ultra-wide-angle-camera',
      'wide-angle-camera',
      'telephoto-camera',
    ],
  });
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const front = position === 'front';

  // 전면 "0.5x"(풀센서 와이드)는 별도 렌즈가 아니라 가장 넓은 화각(FOV) 포맷.
  // → 전면은 device.formats 중 fieldOfView 최대 포맷을 골라 가장 넓게.
  const format = useMemo(() => {
    if (!device || position !== 'front') return undefined;
    // 화각(FOV) 최대. 동률(전면은 보통 전부 동일)이면 '영상에 적당한 해상도'를
    // 선호 — 풀센서 12MP(예: 4032x3024)를 매 프레임 세그멘테이션에 넘기면 과부하라
    // videoHeight ≤ 1600(≈1440p) 중 가장 큰 것을 고른다(화각은 동일 유지).
    const resScore = (f: (typeof device.formats)[number]) =>
      f.videoHeight <= 1600 ? f.videoHeight : 1600 - f.videoHeight;
    let best: (typeof device.formats)[number] | undefined;
    for (const f of device.formats) {
      if (f.videoHeight < 480) continue; // 썸네일급 제외
      if (!best) {
        best = f;
        continue;
      }
      const df = f.fieldOfView - best.fieldOfView;
      if (df > 0.5 || (Math.abs(df) <= 0.5 && resScore(f) > resScore(best))) {
        best = f;
      }
    }
    return best;
  }, [device, position]);

  // 진단 #1: 전면 모든 포맷의 화각/해상도 + 선택/기본 비교
  useEffect(() => {
    if (!device || position !== 'front') return;
    const fmts = device.formats
      .map((f) => ({ w: f.videoWidth, h: f.videoHeight, fov: f.fieldOfView }))
      .sort((a, b) => b.fov - a.fov);
    const fovs = fmts.map((f) => f.fov);
    const fovMax = Math.max(...fovs);
    const fovMin = Math.min(...fovs);
    const spread = fovMax - fovMin;
    console.log(
      `[front-formats] count=${fmts.length} fovMax=${fovMax.toFixed(1)} fovMin=${fovMin.toFixed(1)} spread=${spread.toFixed(1)}°`,
    );
    for (const f of fmts.slice(0, 14)) {
      console.log(`  FOV=${f.fov.toFixed(1)}°  ${f.w}x${f.h}`);
    }
    console.log(
      `[front-selected] FOV=${format?.fieldOfView?.toFixed(1)} ${format?.videoWidth}x${format?.videoHeight}`,
    );
    // 판정: 우리가 최대 화각 포맷을 적용 중인가? 이게 하드웨어/VisionCamera 한계.
    const selFov = format?.fieldOfView ?? 0;
    const atMax = selFov >= fovMax - 0.5;
    console.log(
      `[front-verdict] 선택FOV=${selFov.toFixed(1)}° 최대=${fovMax.toFixed(1)}° ${
        atMax ? '(최대 적용됨)' : '(⚠️최대 아님)'
      } · 이게 VisionCamera 한계(하드웨어 포맷 최대 = 네이티브로도 동일). 순정 0.5x와 비교: 비슷하면 끝, 순정이 확연히 넓으면 VisionCamera가 더 넓은 포맷을 노출 안 한 것 → 네이티브 검토`,
    );
  }, [device, position, format]);

  const refImg = referenceFeatures.imageSize ?? { w: 3, h: 4 };
  // 레퍼런스 실루엣을 실제 구도대로 화면(cover)에 매핑(캐싱). 고정 사각형 X.
  const refScreenUnit = useMemo(
    () => coverUnit(referenceFeatures.bodyOutline, refImg.w, refImg.h, W, H, front),
    [referenceFeatures.bodyOutline, refImg.w, refImg.h, W, H, front],
  );
  const hasRefSil = !!refScreenUnit && refScreenUnit.length >= 3;
  // 레퍼런스 얼굴 위치 가이드(타원) — 미리보기와 동일 매핑(전면 contain).
  const faceGuide = useMemo(() => {
    const fb = referenceFeatures.bbox;
    if (!fb) return null;
    const scale = front
      ? Math.min(W / refImg.w, H / refImg.h)
      : Math.max(W / refImg.w, H / refImg.h);
    const dW = refImg.w * scale;
    const dH = refImg.h * scale;
    const offX = (W - dW) / 2;
    const offY = (H - dH) / 2;
    return {
      cx: offX + (fb.x + fb.w / 2) * dW,
      cy: offY + (fb.y + fb.h / 2) * dH,
      rx: Math.max((fb.w * dW) / 2, 8),
      ry: Math.max((fb.h * dH) / 2, 8),
    };
  }, [referenceFeatures.bbox, refImg.w, refImg.h, W, H, front]);

  const [scores, setScores] = useState<MatchScores>(ZERO);
  const [guide, setGuide] = useState('상체가 보이게 서주세요');
  const [hasFace, setHasFace] = useState(false);
  const [live, setLive] = useState<LiveData | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [debug, setDebug] = useState(true);
  // 어긋난 관절 깜빡임용 토글
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setBlink((b) => !b), 450);
    return () => clearInterval(id);
  }, []);

  // 레퍼런스 자세 분석 — 사진 선택 시 1회(사람이 읽을 수 있는 요약).
  const poseSummary = useMemo(
    () => summarizePose(referenceFeatures.pose),
    [referenceFeatures.pose],
  );
  // 레퍼런스 얼굴 각도 분석 — 사진 선택 시 1회.
  const faceSummary = useMemo(
    () =>
      referenceFeatures.hasFace
        ? summarizeFace(referenceFeatures.orientation)
        : null,
    [referenceFeatures.hasFace, referenceFeatures.orientation],
  );

  const [zoom, setZoom] = useState(device?.neutralZoom ?? 1);
  const startZoom = useRef(device?.neutralZoom ?? 1);
  useEffect(() => {
    if (!device) return;
    // 요구 #4: 렌즈가 바뀌면 줌 범위도 다르므로 neutralZoom 으로 리셋
    setZoom(device.neutralZoom);
    startZoom.current = device.neutralZoom;
    // 요구 #1(문제2): 전면/후면 device 값 로그
    console.log(
      `[device] ${position}:`,
      'min=', device.minZoom,
      'neutral=', device.neutralZoom,
      'max=', device.maxZoom,
      'lenses=', device.physicalDevices,
    );
  }, [device, position]);
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onBegin(() => {
      startZoom.current = zoom;
    })
    .onUpdate((e) => {
      if (device)
        setZoom(clamp(startZoom.current * e.scale, device.minZoom, device.maxZoom));
    });

  const lastReport = useSharedValue(0);
  const lastLog = useSharedValue(0);
  const lastFrLog = useSharedValue(0);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const capture = async () => {
    if (capturing || cameraRef.current == null) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePhoto();
      navigation.replace('Compare', {
        referenceUri,
        shotUri: `file://${photo.path}`,
        matchScore: scores.overall,
        fromHistory: false,
      });
    } catch (e) {
      console.error('촬영 실패', e);
      setCapturing(false);
    }
  };

  // 시간적 스무딩 + 실패 프레임 hold. 정지 상태면 가이드도 정지하도록.
  const smoother = useRef(createLiveSmoother());
  const lastScores = useRef<MatchScores>(ZERO);
  const lastGuide = useRef('상체가 보이게 서주세요');
  const report = Worklets.createRunOnJS(
    (s: MatchScores, g: string, ok: boolean, ld: LiveData | null) => {
      const now = Date.now();
      const sm = smoother.current.update(ld, now);
      if (ld && ok) {
        // 양호 프레임: 점수/문구 갱신(이후 hold 구간에서 재사용).
        lastScores.current = s;
        lastGuide.current = g;
      }
      if (sm) {
        // 검출 또는 hold 구간: 부드러운 값으로 표시 유지(깜빡임 없음).
        setHasFace(true);
        setScores(lastScores.current);
        setLive(sm as LiveData);
        setGuide(lastGuide.current);
      } else {
        // holdMs 초과로 진짜 사라짐 → 그때만 숨김/초기화.
        smoother.current.reset();
        setHasFace(false);
        setScores(ZERO);
        setLive(null);
        setGuide(g);
      }
    },
  );
  const reportDiag = Worklets.createRunOnJS((d: Diag) => setDiag(d));

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      const raw = facePlugin?.call(frame) as unknown as FaceVisionResult | undefined;
      const lf = raw ? toFaceFeatures(raw) : null;
      const now = Date.now();

      // 진단(요구 #1): 얼굴 랜드마크/윤곽이 라이브 프레임 프로세서까지 들어오는가?
      // 얼굴이 안 잡혀도 매 프레임 상태를 찍는다. (레퍼런스 경로와 별개)
      if (now - lastLog.value > 500) {
        lastLog.value = now;
        const cN = raw?.faceContour?.length ?? 0;
        const pN = raw?.pose ? Object.keys(raw.pose).length : 0;
        const sN = raw?.bodyOutline?.length ?? 0;
        console.log(
          '[shoot] found=', raw?.found,
          'pose=', pN,
          'poseObs=', raw?.poseObs,
          'poseRaw=', raw?.poseRaw,
          'poseOri=', raw?.poseOri,
          'frameOri=', raw?.frameOri,
          'silhouette=', sN,
          'frame=', frame.width, 'x', frame.height,
        );
        reportDiag({
          found: !!raw?.found,
          noFace: !!raw?.noFace,
          contourN: cN,
          poseN: pN,
          poseObs: raw?.poseObs ?? 0,
          poseRaw: raw?.poseRaw ?? 0,
          poseOri: raw?.poseOri ?? 'none',
          silN: sN,
          fw: frame.width,
          fh: frame.height,
        });

      }

      if (!lf) {
        if (now - lastReport.value > 150) {
          lastReport.value = now;
          report(ZERO, '사람이 보이지 않아요', false, null);
        }
        return;
      }

      // 라이브 세그 마스크는 raw 버퍼 방향 → 얼굴 좌표계와 y 반전. 보정(라이브만).
      if (lf.bodyOutline) {
        const fb = lf.bodyOutline;
        for (let i = 0; i < fb.length; i++) fb[i] = { x: fb[i].x, y: 1 - fb[i].y };
      }

      // 포즈 수직 자동보정(데이터 기반): 정상 자세는 어깨가 골반보다, 목이 어깨보다
      // 위(top-left y 작음). 검출 방향에 따라 상하 반전될 수 있어 직접 판정 → flip.
      // (네이티브가 직립 방향을 고르므로 보통 trigger 안 되지만, 안전장치로 멱등.)
      if (lf.pose) {
        const p = lf.pose;
        const sY =
          p.leftShoulder && p.rightShoulder
            ? (p.leftShoulder.y + p.rightShoulder.y) / 2
            : p.leftShoulder?.y ?? p.rightShoulder?.y;
        let inverted = false;
        if (sY != null && p.root) inverted = sY > p.root.y;
        else if (sY != null && p.neck) inverted = p.neck.y > sY + 0.02;
        if (inverted) {
          for (const k of Object.keys(p) as (keyof PoseJoints)[]) {
            const j = p[k];
            if (j) j.y = 1 - j.y;
          }
        }
      }

      const s0 = matchFace(referenceFeatures, lf);
      // 실루엣 IoU(주력 매칭) — 둘 다 화면(cover)에 매핑한 뒤 실제 겹침 비교.
      // 겹칠수록 점수↑ (위치/크기/구도까지 맞춰야 함).
      const lw = Math.min(frame.width, frame.height);
      const lh = Math.max(frame.width, frame.height);
      const liveScreenUnit = coverUnit(lf.bodyOutline, lw, lh, W, H, front);
      const iou = hasRefSil ? silhouetteIoU(refScreenUnit, liveScreenUnit) : 0;
      // 구도(framing): 얼굴 bbox 를 주 신호로(위치+거리 민감). 단, 라이브 얼굴 세로(cy)가
      // 검출 방향 오류로 반전될 수 있어 '얼굴은 인물 상단' 가정으로 자동 보정.
      // 얼굴 없을 때만 실루엣 bbox 로 폴백(포화되지만 0은 면함).
      const silFr = hasRefSil ? framingFromUnits(refScreenUnit, liveScreenUnit) : null;
      let frUse: FramingResult | null = silFr;
      let frSrc = 'sil';
      if (referenceFeatures.hasFace && lf.hasFace) {
        const rcx = referenceFeatures.framing.cx;
        const rcy = referenceFeatures.framing.cy;
        const rsz = referenceFeatures.framing.size;
        const lcx = lf.framing.cx;
        let lcy = lf.framing.cy;
        const lsz = lf.framing.size;
        // 세로 반전 자동 판정: 얼굴 cy 가 인물 실루엣 중심보다 아래면 뒤집힘 → 1-cy.
        const lBox = unitBBox(lf.bodyOutline);
        if (lBox && lcy > lBox.cy + 0.05) lcy = 1 - lcy;
        const dpos = Math.hypot(rcx - lcx, rcy - lcy);
        const dsize = Math.abs(rsz - lsz) / Math.max(rsz, 0.01);
        const sc =
          (Math.max(0, Math.min(1, 1 - dpos / 0.16)) +
            Math.max(0, Math.min(1, 1 - dsize / 0.45))) /
          2;
        frUse = {
          score: sc,
          dpos,
          dsize,
          ref: { cx: rcx, cy: rcy, w: 0, h: 0, size: rsz },
          live: { cx: lcx, cy: lcy, w: 0, h: 0, size: lsz },
        };
        frSrc = 'face';
      }
      const framingScore = frUse ? frUse.score : s0.framing;
      // 진단: 구도 점수(0 병목 해결 + 민감도 확인용).
      if (frUse && now - lastFrLog.value > 500) {
        lastFrLog.value = now;
        console.log(
          '[framing2]', frSrc, 'score=', framingScore.toFixed(2),
          'dpos=', frUse.dpos.toFixed(3), 'dsize=', frUse.dsize.toFixed(3),
          'ref=', frUse.ref ? `${frUse.ref.cx.toFixed(2)},${frUse.ref.cy.toFixed(2)} s${frUse.ref.size.toFixed(2)}` : '-',
          'live=', frUse.live ? `${frUse.live.cx.toFixed(2)},${frUse.live.cy.toFixed(2)} s${frUse.live.size.toFixed(2)}` : '-',
        );
      }
      const s = hasRefSil
        ? {
            ...s0,
            pose: iou,
            framing: framingScore,
            hasPose: true,
            overall:
              iou * 0.5 +
              framingScore * 0.26 +
              s0.orientation * 0.1 +
              s0.expression * 0.08 +
              s0.gaze * 0.06,
          }
        : s0;
      // 자동 셔터 제거 — 점수/가이드만 갱신, 촬영은 수동 셔터 버튼만.

      if (now - lastReport.value > 120) {
        lastReport.value = now;
        // 구도 어긋남 우선 안내(가까이/멀리/위/아래) → 실루엣 맞추기.
        const fg = frUse ? framingGuide(frUse) : '';
        const g = !hasRefSil
          ? guideText(referenceFeatures, lf, s)
          : iou >= POSE_IOU_GOOD && framingScore >= 0.7
            ? '완벽해요! 그대로!'
            : fg !== ''
              ? fg
              : iou >= 0.3
                ? '거의 맞았어요 — 조금 더'
                : '실루엣 안에 몸을 맞춰요';
        report(s, g, true, {
          bodyOutline: lf.bodyOutline,
          pose: lf.pose,
          iou,
          cx: lf.framing.cx,
          cy: lf.framing.cy,
          size: lf.framing.size,
          fw: frame.width,
          fh: frame.height,
          yaw: lf.orientation.yaw,
          pitch: lf.orientation.pitch,
          roll: lf.orientation.roll,
          face: lf.hasFace,
        });
      }
    },
    [
      referenceFeatures,
      refScreenUnit,
      hasRefSil,
      W,
      H,
      front,
      report,
      reportDiag,
    ],
  );

  if (!hasPermission || device == null) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>
          {!hasPermission ? '카메라 권한이 필요합니다' : '카메라를 찾을 수 없습니다'}
        </Text>
      </View>
    );
  }

  const presets = ZOOM_PRESETS.filter((d) => presetAvailable(d, device));
  const activeMul = zoomToDisplay(zoom, device);

  // 실제 구도대로 화면에 매핑된 실루엣(스무딩 + 곡선 path).
  const toPx = (u: Pt[] | null) =>
    u ? u.map((p) => ({ x: p.x * W, y: p.y * H })) : null;
  const liveScreenUnit = live
    ? coverUnit(
        live.bodyOutline,
        Math.min(live.fw, live.fh),
        Math.max(live.fw, live.fh),
        W,
        H,
        front,
      )
    : null;
  // 레퍼런스/라이브 동일 파이프라인(약한 스무딩 + 직선 폴리곤) → 디테일 유지·모양 일치.
  // contour(닫힌 루프)는 네이티브 DP로 이미 정리됨 → 직선 그대로(디테일 유지).
  const refPoly = svgPolyPoints(toPx(refScreenUnit));
  const livePoly = svgPolyPoints(toPx(liveScreenUnit));
  // 포즈 스켈레톤(자세 매칭 주). 목표=레퍼런스, 라이브=내 관절.
  // 라이브 포즈는 워클릿에서 데이터 기반으로 이미 상하보정됨 → flipY 불필요.
  const refSkel = poseToScreen(referenceFeatures.pose, refImg.w, refImg.h, W, H, front);
  const liveSkel = live
    ? poseToScreen(
        live.pose,
        Math.min(live.fw, live.fh),
        Math.max(live.fw, live.fh),
        W,
        H,
        front,
        false,
      )
    : {};

  // 자세 비교(화면 픽셀 공간). target(고스트)을 내 어깨프레임에 앉혀 돌려준다.
  const liveJ = liveSkel as JMap;
  const cmp: PoseComparison | null =
    referenceFeatures.pose && Object.keys(liveSkel).length > 0
      ? comparePose(referenceFeatures.pose as JMap, liveJ)
      : null;
  // 고스트 타깃(내 몸 위 흰색 목표). 라이브 포즈 없으면 절대위치 레퍼런스로 폴백.
  const ghost = cmp && Object.keys(cmp.target).length > 0 ? cmp.target : null;
  const targetSkel = (ghost ?? refSkel) as Partial<Record<keyof PoseJoints, Pt>>;
  const jointOk = cmp?.jointOk ?? {};
  // 어긋난 관절 색: 빨강(깜빡임). 일치: 초록.
  const jointColor = (k: keyof PoseJoints): string => {
    if (jointOk[k] === true) return '#00E08A';
    if (jointOk[k] === false) return blink ? '#FF3B30' : '#FF8A80';
    return '#00E08A';
  };
  // 내 얼굴 위치(프레이밍 중심) → 화면 점. 레퍼런스 얼굴 타원과 맞추도록 유도.
  const liveFacePt =
    live && hasFace
      ? (() => {
          const p = coverPoint(
            live.cx,
            live.cy,
            Math.min(live.fw, live.fh),
            Math.max(live.fw, live.fh),
            W,
            H,
            front,
          );
          return { x: p.x * W, y: p.y * H };
        })()
      : null;
  const faceOk =
    faceGuide && liveFacePt
      ? Math.hypot(liveFacePt.x - faceGuide.cx, liveFacePt.y - faceGuide.cy) <
        faceGuide.rx
      : false;
  const iouVal = live?.iou ?? 0;
  const iouColor =
    iouVal >= POSE_IOU_GOOD
      ? '#00E08A'
      : iouVal >= 0.3
        ? '#FFD400'
        : 'rgba(255,255,255,0.9)';
  const iouFill =
    iouVal >= POSE_IOU_GOOD ? 'rgba(0,224,138,0.30)' : 'rgba(255,255,255,0.22)';

  // ── 얼굴 각도(고개) 비교 + 시각 인디케이터(글자보다 우선) ──
  const faceActive = referenceFeatures.hasFace && !!live && !!live.face;
  const faceCmp: FaceCompare | null =
    faceActive && live
      ? compareFace(referenceFeatures.orientation, {
          yaw: live.yaw,
          pitch: live.pitch,
          roll: live.roll,
        })
      : null;
  // 내 얼굴 중심에 목표(흰)·내(초록/빨강) 기울기선 + yaw/pitch 화살표를 그린다.
  const faceInd =
    faceCmp && liveFacePt && live
      ? (() => {
          const R = faceGuide ? Math.max(faceGuide.ry, 40) : Math.min(W, H) * 0.14;
          const cx = liveFacePt.x;
          const cy = liveFacePt.y;
          // roll 축선: head-up 방향 = (sinθ, -cosθ). 두 선이 겹치면 roll 일치.
          const axis = (theta: number) => ({
            x1: cx - R * Math.sin(theta),
            y1: cy + R * Math.cos(theta),
            x2: cx + R * Math.sin(theta),
            y2: cy - R * Math.cos(theta),
          });
          const refAxis = axis(referenceFeatures.orientation.roll);
          const myAxis = axis(live.roll);
          // yaw/pitch 는 "facing dot" 겹침으로 안내(미러 부호와 무관하게 수렴).
          // 점 위치 = 얼굴중심 + (yaw, -pitch)*k. 내 점을 흰 목표점에 겹치면 맞음.
          const k = R / 0.45;
          const o = referenceFeatures.orientation;
          const refDot = { x: cx + o.yaw * k, y: cy - o.pitch * k };
          const myDot = { x: cx + live.yaw * k, y: cy - live.pitch * k };
          const dirOk = faceCmp.yawOk && faceCmp.pitchOk;
          return { cx, cy, R, refAxis, myAxis, refDot, myDot, dirOk };
        })()
      : null;

  // 통합 가이드 우선순위: 자세(몸) → 얼굴 각도 → 둘 다 맞으면 완성.
  const poseDone = !cmp || cmp.allMatched;
  const faceDone = !faceCmp || faceCmp.ok;
  const anyGuide = !!cmp || !!faceCmp;
  const allDone = anyGuide && poseDone && faceDone;
  const headline = !poseDone
    ? cmp!.guide
    : !faceDone
      ? faceCmp!.guide
      : allDone
        ? '✓ 자세·각도 완성! 그대로!'
        : guide;

  return (
    <View style={styles.container}>
      <GestureDetector gesture={pinch}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          format={format}
          resizeMode={front ? 'contain' : 'cover'}
          isActive={!capturing}
          photo
          frameProcessor={frameProcessor}
          pixelFormat="yuv"
          zoom={zoom}
        />
      </GestureDetector>

      {/* 실루엣 오버레이 — SVG(일반 UIView)라 카메라 위에 정상 합성됨. 부드러운 곡선. */}
      <Svg
        style={StyleSheet.absoluteFill}
        width={W}
        height={H}
        pointerEvents="none"
      >
        {/* 레퍼런스(목표): 반투명 채움 + 흰 외곽선. "여기 몸을 맞춰라" */}
        {refPoly && (
          <Polygon
            points={refPoly}
            fill={iouFill}
            stroke={iouColor}
            strokeWidth={4}
            strokeLinejoin="round"
          />
        )}
        {/* 내 실시간 실루엣: 초록 외곽선(목표와 구분) */}
        {livePoly && (
          <Polygon
            points={livePoly}
            fill="none"
            stroke="#00E08A"
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
        )}
        {/* 목표 스켈레톤(흰, 반투명) — 내 몸 위에 겹친 고스트(또는 폴백: 레퍼런스 위치) */}
        {POSE_EDGES.map(([a, b], i) => {
          const pa = targetSkel[a];
          const pb = targetSkel[b];
          return pa && pb ? (
            <SvgLine
              key={`re${i}`}
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke="rgba(255,255,255,0.85)"
              strokeWidth={5}
              strokeLinecap="round"
            />
          ) : null;
        })}
        {(Object.keys(targetSkel) as (keyof PoseJoints)[]).map((k) => {
          const p = targetSkel[k];
          return p ? (
            <SvgCircle key={`rj${k}`} cx={p.x} cy={p.y} r={6} fill="#fff" />
          ) : null;
        })}
        {/* 내 실시간 스켈레톤(선=초록) + 관절점은 일치 여부로 색(초록/빨강 깜빡) */}
        {POSE_EDGES.map(([a, b], i) => {
          const pa = liveSkel[a];
          const pb = liveSkel[b];
          // 두 관절 중 어긋난 게 있으면 선도 빨강 강조(어디를 움직일지 직관적으로)
          const bad = jointOk[a] === false || jointOk[b] === false;
          return pa && pb ? (
            <SvgLine
              key={`le${i}`}
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke={bad ? (blink ? '#FF3B30' : '#FF8A80') : '#00E08A'}
              strokeWidth={bad ? 4.5 : 3.5}
              strokeLinecap="round"
            />
          ) : null;
        })}
        {(Object.keys(liveSkel) as (keyof PoseJoints)[]).map((k) => {
          const p = liveSkel[k];
          const bad = jointOk[k] === false;
          return p ? (
            <SvgCircle
              key={`lj${k}`}
              cx={p.x}
              cy={p.y}
              r={bad ? 7 : 5}
              fill={jointColor(k)}
            />
          ) : null;
        })}
        {/* 얼굴 위치 가이드(목표 타원) */}
        {faceGuide && (
          <Ellipse
            cx={faceGuide.cx}
            cy={faceGuide.cy}
            rx={faceGuide.rx}
            ry={faceGuide.ry}
            fill="none"
            stroke={faceOk ? '#00E08A' : '#22D3EE'}
            strokeWidth={3}
            strokeDasharray="10 8"
          />
        )}
        {/* 내 얼굴 중심(여기를 타원에 맞춰라) */}
        {liveFacePt && (
          <SvgCircle
            cx={liveFacePt.x}
            cy={liveFacePt.y}
            r={10}
            fill={faceOk ? '#00E08A' : 'rgba(34,211,238,0.9)'}
          />
        )}
        {/* 얼굴 각도(고개) 인디케이터: 목표 기울기선(흰) + 내 기울기선(roll ok=초록/빨강) */}
        {faceInd && faceCmp && (
          <>
            <SvgLine
              x1={faceInd.refAxis.x1}
              y1={faceInd.refAxis.y1}
              x2={faceInd.refAxis.x2}
              y2={faceInd.refAxis.y2}
              stroke="rgba(255,255,255,0.9)"
              strokeWidth={4}
              strokeLinecap="round"
            />
            <SvgLine
              x1={faceInd.myAxis.x1}
              y1={faceInd.myAxis.y1}
              x2={faceInd.myAxis.x2}
              y2={faceInd.myAxis.y2}
              stroke={faceCmp.rollOk ? '#00E08A' : blink ? '#FF3B30' : '#FF8A80'}
              strokeWidth={3}
              strokeLinecap="round"
            />
            {!faceInd.dirOk && (
              <SvgLine
                x1={faceInd.myDot.x}
                y1={faceInd.myDot.y}
                x2={faceInd.refDot.x}
                y2={faceInd.refDot.y}
                stroke={blink ? '#FF3B30' : '#FFD400'}
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray="4 4"
              />
            )}
            <SvgCircle
              cx={faceInd.refDot.x}
              cy={faceInd.refDot.y}
              r={8}
              fill="none"
              stroke="rgba(255,255,255,0.95)"
              strokeWidth={3}
            />
            <SvgCircle
              cx={faceInd.myDot.x}
              cy={faceInd.myDot.y}
              r={6}
              fill={faceInd.dirOk ? '#00E08A' : blink ? '#FF3B30' : '#FF8A80'}
            />
          </>
        )}
      </Svg>

      <View pointerEvents="none" style={styles.guideWrap}>
        {/* 레퍼런스 자세/각도 요약(1회 분석 결과) */}
        {poseSummary && (
          <Text style={styles.summary}>📸 {poseSummary}</Text>
        )}
        {faceSummary && (
          <Text style={styles.summary}>🙂 고개: {faceSummary}</Text>
        )}
        {/* 주 가이드: 자세(몸) → 얼굴 각도 → 완성. 없으면 기존 가이드 */}
        <Text style={[styles.guideText, allDone && styles.guideDone]}>
          {headline}
        </Text>
        {/* 부위별 일치 표시(맞으면 초록). 자세 부위 + 얼굴 각도(각도) */}
        {anyGuide && (
          <View style={styles.chips}>
            {cmp &&
              (Object.keys(PART_LABEL) as PartKey[]).map((p) => {
                const st = cmp.parts[p];
                const c = !st.present
                  ? 'rgba(255,255,255,0.25)'
                  : st.ok
                    ? '#00E08A'
                    : '#FF3B30';
                return (
                  <View
                    key={p}
                    style={[styles.chip, { borderColor: c, backgroundColor: `${c}22` }]}
                  >
                    <Text style={[styles.chipText, { color: c }]}>
                      {st.ok && st.present ? '✓ ' : ''}
                      {PART_LABEL[p]}
                    </Text>
                  </View>
                );
              })}
            {faceCmp &&
              (() => {
                const c = faceCmp.ok ? '#00E08A' : '#FF3B30';
                return (
                  <View
                    style={[styles.chip, { borderColor: c, backgroundColor: `${c}22` }]}
                  >
                    <Text style={[styles.chipText, { color: c }]}>
                      {faceCmp.ok ? '✓ ' : ''}각도
                    </Text>
                  </View>
                );
              })()}
          </View>
        )}
        {!hasRefSil && !cmp && (
          <Text style={styles.warn}>이 레퍼런스에서 인물 실루엣을 못 잡았어요</Text>
        )}
      </View>

      {/* 진단 (좌표 정합 확인용) */}
      {debug && (
        <Pressable style={styles.debug} onPress={() => setDebug(false)}>
          <Text style={styles.debugText}>
            DEVICE {position} min={device.minZoom.toFixed(3)} neutral=
            {device.neutralZoom.toFixed(3)} max={device.maxZoom.toFixed(1)}
            {'\n'}lenses=[{device.physicalDevices.join(',')}] FOV=
            {format ? `${format.fieldOfView.toFixed(0)}° ${format.videoWidth}x${format.videoHeight}` : 'default'}
            {'\n'}presets={presets.join('/')} ultraWide={device.minZoom < 1 ? 'Y' : 'N'}
            {'\n'}FACE found={diag?.found ? 'Y' : 'N'} 실루엣={diag?.silN ?? 0} IoU=
            {Math.round(iouVal * 100)}
            {'\n'}POSE 관절={diag?.poseN ?? 0} obs={diag?.poseObs ?? 0} raw=
            {diag?.poseRaw ?? 0} ori={diag?.poseOri ?? '-'} refPose=
            {referenceFeatures.pose ? 'Y' : 'N'}
            {'\n'}CMP worst={cmp?.worst ?? '-'} done={cmp?.allMatched ? 'Y' : 'N'}{' '}
            ghost={ghost ? 'Y' : 'N'}
            {'\n'}FACE각도 worst={faceCmp?.worst ?? '-'} ok={faceCmp?.ok ? 'Y' : 'N'}{' '}
            y/p/r={live ? `${live.yaw.toFixed(2)}/${live.pitch.toFixed(2)}/${live.roll.toFixed(2)}` : '-'}
            {'\n'}(탭하면 숨김)
          </Text>
        </Pressable>
      )}

      <View pointerEvents="none" style={styles.bars}>
        {scores.hasPose && <Bar label="실루엣" v={scores.pose} big />}
        <Bar label="구도" v={scores.framing} />
        <Bar label="각도" v={scores.orientation} />
        <Bar label="표정" v={scores.expression} />
        <Bar label="시선" v={scores.gaze} />
        <Text style={styles.overall}>종합 {Math.round(scores.overall * 100)}%</Text>
      </View>

      {/* 전면: 풀FOV(0.5x)~크롭(1x/2x) 디지털 줌(기본 카메라 동일 라벨). 후면: 실제 렌즈. */}
      {front ? (
        <View style={styles.zoomRow}>
          {FRONT_ZOOM_MAP.map(({ label }) => {
            const active = frontActiveLabel(zoom, device) === label;
            return (
              <Pressable
                key={label}
                style={[styles.zoomBtn, active && styles.zoomBtnOn]}
                onPress={() => setZoom(frontZoom(label, device))}
              >
                <Text style={[styles.zoomText, active && styles.zoomTextOn]}>
                  {active ? `${label}×` : `${label}`}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        presets.length > 1 && (
          <View style={styles.zoomRow}>
            {presets.map((m) => {
              const active = Math.abs(activeMul - m) < 0.06;
              return (
                <Pressable
                  key={m}
                  style={[styles.zoomBtn, active && styles.zoomBtnOn]}
                  onPress={() => setZoom(displayToZoom(m, device))}
                >
                  <Text style={[styles.zoomText, active && styles.zoomTextOn]}>
                    {active ? `${m}×` : `${m}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )
      )}

      <Pressable
        style={styles.flip}
        onPress={() => setPosition((p) => (p === 'front' ? 'back' : 'front'))}
      >
        <Text style={styles.flipText}>{front ? '후면' : '전면'}</Text>
      </Pressable>

      <Pressable style={styles.shutter} onPress={capture} disabled={capturing}>
        <View style={styles.shutterInner} />
      </Pressable>
    </View>
  );
}

function Bar({ label, v, big }: { label: string; v: number; big?: boolean }) {
  const ok = v >= MATCH_THRESHOLD;
  return (
    <View style={styles.barRow}>
      <Text style={[styles.barLabel, big && styles.barLabelBig]}>{label}</Text>
      <View style={[styles.barTrack, big && styles.barTrackBig]}>
        <View
          style={[
            styles.barFill,
            big && styles.barTrackBig,
            { width: `${Math.round(v * 100)}%`, backgroundColor: ok ? '#00E08A' : '#FFB020' },
          ]}
        />
      </View>
      <Text style={styles.barPct}>{Math.round(v * 100)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  centerText: { color: '#fff', fontSize: 16 },
  guideWrap: { position: 'absolute', top: 100, left: 16, right: 16, alignItems: 'center' },
  guideText: {
    color: '#FFF',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 14,
    overflow: 'hidden',
  },
  guideDone: { color: '#0D0D0F', backgroundColor: '#00E08A' },
  summary: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    overflow: 'hidden',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
  },
  chip: {
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 12, fontWeight: '700' },
  warn: {
    color: '#FFD400',
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: 'hidden',
  },
  debug: {
    position: 'absolute',
    top: 200,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    padding: 8,
  },
  debugText: { color: '#7FFFD4', fontSize: 11, fontFamily: 'Courier' },
  bars: {
    position: 'absolute',
    bottom: 180,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { color: '#FFF', fontSize: 13, width: 32 },
  barLabelBig: { fontSize: 15, fontWeight: '700' },
  barTrack: {
    flex: 1,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  barTrackBig: { height: 12, borderRadius: 6 },
  barFill: { height: 8, borderRadius: 4 },
  barPct: { color: '#FFF', fontSize: 12, width: 26, textAlign: 'right' },
  overall: { color: '#00E08A', fontSize: 14, fontWeight: '700', marginTop: 4 },
  zoomRow: {
    position: 'absolute',
    bottom: 126,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  zoomBtn: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 16,
    minWidth: 38,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
  },
  zoomBtnOn: { backgroundColor: '#FFD400' },
  zoomText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  zoomTextOn: { color: '#0D0D0F', fontSize: 13, fontWeight: '800' },
  flip: {
    position: 'absolute',
    bottom: 56,
    right: 28,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  flipText: { color: '#FFF', fontSize: 14, fontWeight: '600' },
  shutter: {
    position: 'absolute',
    bottom: 44,
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#FFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFF' },
});
