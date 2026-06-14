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
import { toFaceFeatures, type FaceVisionResult, type Pt } from '../face/types';
import {
  matchFace,
  MATCH_THRESHOLD,
  SHUTTER_COOLDOWN_MS,
  SHUTTER_HOLD_MS,
  type MatchScores,
} from '../face/matchFace';
import { guideText } from '../face/guide';
import {
  silhouetteIoU,
  coverUnit,
  smoothEdges,
  toSmoothPathD,
  POSE_IOU_GOOD,
} from '../face/silhouette';
import Svg, { Path as SvgPath, Ellipse, Circle as SvgCircle } from 'react-native-svg';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Shoot'>;
type Rt = RouteProp<RootStackParamList, 'Shoot'>;

const facePlugin = VisionCameraProxy.initFrameProcessorPlugin('detectFace', {});

// 후면 전용 줌 프리셋(전면은 풀FOV 고정 → 배율 의미 없음, UI 숨김).
const ZOOM_PRESETS = [0.5, 0.6, 0.8, 1, 1.5, 2];
const clamp = (z: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, z));
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
  iou: number; // 레퍼런스 실루엣과의 겹침(주력 매칭)
  cx: number;
  cy: number;
  size: number;
  fw: number;
  fh: number;
}

// 매 프레임 검출 상태(얼굴이 안 잡혀도 항상 갱신) — 진단용
interface Diag {
  found: boolean;
  noFace: boolean;
  contourN: number;
  poseN: number;
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
    let best: (typeof device.formats)[number] | undefined;
    for (const f of device.formats) {
      if (f.videoHeight < 480) continue; // 썸네일급 제외
      if (!best) {
        best = f;
        continue;
      }
      // 화각 최대, 동률이면 해상도 높은 것
      const df = f.fieldOfView - best.fieldOfView;
      if (
        df > 0.5 ||
        (Math.abs(df) <= 0.5 &&
          f.videoWidth * f.videoHeight > best.videoWidth * best.videoHeight)
      ) {
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
    console.log(
      `[front-formats] count=${fmts.length} fovMax=${Math.max(...fovs).toFixed(1)} fovMin=${Math.min(...fovs).toFixed(1)}`,
    );
    for (const f of fmts.slice(0, 14)) {
      console.log(`  FOV=${f.fov.toFixed(1)}°  ${f.w}x${f.h}`);
    }
    console.log(
      `[front-selected] FOV=${format?.fieldOfView?.toFixed(1)} ${format?.videoWidth}x${format?.videoHeight}`,
    );
  }, [device, position, format]);

  const refImg = referenceFeatures.imageSize ?? { w: 3, h: 4 };
  // 레퍼런스 실루엣을 실제 구도대로 화면(cover)에 매핑(캐싱). 고정 사각형 X.
  const refScreenUnit = useMemo(
    () => coverUnit(referenceFeatures.bodyOutline, refImg.w, refImg.h, W, H),
    [referenceFeatures.bodyOutline, refImg.w, refImg.h, W, H],
  );
  const hasRefSil = !!refScreenUnit && refScreenUnit.length >= 3;
  // 레퍼런스 얼굴 위치 가이드(타원) — face bbox 를 화면에 cover 매핑.
  const faceGuide = useMemo(() => {
    const fb = referenceFeatures.bbox;
    if (!fb) return null;
    const scale = Math.max(W / refImg.w, H / refImg.h);
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
  }, [referenceFeatures.bbox, refImg.w, refImg.h, W, H]);

  const [scores, setScores] = useState<MatchScores>(ZERO);
  const [guide, setGuide] = useState('상체가 보이게 서주세요');
  const [hasFace, setHasFace] = useState(false);
  const [live, setLive] = useState<LiveData | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [debug, setDebug] = useState(true);

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
      // 전면은 풀FOV 고정 → 줌(디지털 크롭) 비활성화
      if (device && !front)
        setZoom(clamp(startZoom.current * e.scale, device.minZoom, device.maxZoom));
    });

  const highSince = useSharedValue(0);
  const cooldownUntil = useSharedValue(0);
  const lastReport = useSharedValue(0);
  const lastLog = useSharedValue(0);

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

  const report = Worklets.createRunOnJS(
    (s: MatchScores, g: string, ok: boolean, ld: LiveData | null) => {
      setHasFace(ok);
      setScores(ok ? s : ZERO);
      setGuide(g);
      setLive(ld);
    },
  );
  const reportDiag = Worklets.createRunOnJS((d: Diag) => setDiag(d));
  const triggerShutter = Worklets.createRunOnJS(() => capture());

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
          'noFace=', raw?.noFace,
          'faceContour=', cN,
          'pose=', pN,
          'silhouette=', sN,
          'frame=', frame.width, 'x', frame.height,
        );
        reportDiag({
          found: !!raw?.found,
          noFace: !!raw?.noFace,
          contourN: cN,
          poseN: pN,
          silN: sN,
          fw: frame.width,
          fh: frame.height,
        });
      }

      if (!lf) {
        highSince.value = 0;
        if (now - lastReport.value > 150) {
          lastReport.value = now;
          report(ZERO, '사람이 보이지 않아요', false, null);
        }
        return;
      }

      const s0 = matchFace(referenceFeatures, lf);
      // 실루엣 IoU(주력 매칭) — 둘 다 화면(cover)에 매핑한 뒤 실제 겹침 비교.
      // 겹칠수록 점수↑ (위치/크기/구도까지 맞춰야 함).
      const lw = Math.min(frame.width, frame.height);
      const lh = Math.max(frame.width, frame.height);
      const liveScreenUnit = coverUnit(lf.bodyOutline, lw, lh, W, H);
      const iou = hasRefSil ? silhouetteIoU(refScreenUnit, liveScreenUnit) : 0;
      const s = hasRefSil
        ? {
            ...s0,
            pose: iou,
            hasPose: true,
            overall:
              iou * 0.6 +
              s0.framing * 0.16 +
              s0.orientation * 0.1 +
              s0.expression * 0.08 +
              s0.gaze * 0.06,
          }
        : s0;
      // 실루엣 매칭이 가능하면 셔터는 IoU 기준, 아니면 기존 얼굴 기준.
      const allGood = hasRefSil
        ? iou >= POSE_IOU_GOOD
        : s0.framing >= MATCH_THRESHOLD &&
          s0.orientation >= MATCH_THRESHOLD &&
          s0.expression >= MATCH_THRESHOLD &&
          s0.gaze >= MATCH_THRESHOLD;

      if (now >= cooldownUntil.value) {
        if (allGood) {
          if (highSince.value === 0) highSince.value = now;
          if (now - highSince.value >= SHUTTER_HOLD_MS) {
            highSince.value = 0;
            cooldownUntil.value = now + SHUTTER_COOLDOWN_MS;
            triggerShutter();
          }
        } else {
          highSince.value = 0;
        }
      }

      if (now - lastReport.value > 120) {
        lastReport.value = now;
        const g = !hasRefSil
          ? guideText(referenceFeatures, lf, s)
          : iou >= POSE_IOU_GOOD
            ? '완벽해요! 그대로!'
            : iou >= 0.3
              ? '거의 맞았어요 — 조금 더'
              : '실루엣 안에 몸을 맞춰요';
        report(s, g, true, {
          bodyOutline: lf.bodyOutline,
          iou,
          cx: lf.framing.cx,
          cy: lf.framing.cy,
          size: lf.framing.size,
          fw: frame.width,
          fh: frame.height,
        });
      }
    },
    [
      referenceFeatures,
      refScreenUnit,
      hasRefSil,
      W,
      H,
      report,
      reportDiag,
      triggerShutter,
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
      )
    : null;
  const refD = toSmoothPathD(smoothEdges(toPx(refScreenUnit)));
  const liveD = toSmoothPathD(smoothEdges(toPx(liveScreenUnit)));
  // 내 얼굴 위치(프레이밍 중심) → 화면 점. 레퍼런스 얼굴 타원과 맞추도록 유도.
  const liveFacePt =
    live && hasFace
      ? (() => {
          const lw = Math.min(live.fw, live.fh);
          const lh = Math.max(live.fw, live.fh);
          const scale = Math.max(W / lw, H / lh);
          const dW = lw * scale;
          const dH = lh * scale;
          return {
            x: (W - dW) / 2 + live.cx * dW,
            y: (H - dH) / 2 + live.cy * dH,
          };
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

  return (
    <View style={styles.container}>
      <GestureDetector gesture={pinch}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          format={format}
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
        {/* 레퍼런스(목표): 반투명 채움 + 외곽선. 실제 구도 위치. "여기 몸을 맞춰라" */}
        {refD && (
          <SvgPath
            d={refD}
            fill={iouFill}
            stroke={iouColor}
            strokeWidth={5}
            strokeLinejoin="round"
          />
        )}
        {/* 내 실시간 실루엣: 얇은 흰색 외곽선 */}
        {liveD && (
          <SvgPath
            d={liveD}
            fill="none"
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        )}
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
      </Svg>

      <View pointerEvents="none" style={styles.guideWrap}>
        <Text style={styles.guideText}>{guide}</Text>
        {!hasRefSil && (
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
            {'\n'}FACE found={diag?.found ? 'Y' : 'N'} 실루엣={diag?.silN ?? 0} refSil=
            {hasRefSil ? refScreenUnit!.length : 0} IoU={Math.round(iouVal * 100)}{' '}
            frame={diag ? `${diag.fw}x${diag.fh}` : '-'}
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

      {/* 전면: 풀FOV 고정(배율 의미 없음) → '와이드' 한 칸만. 후면: 실제 렌즈 프리셋. */}
      {front ? (
        <View style={styles.zoomRow}>
          <View style={[styles.zoomBtn, styles.zoomBtnOn]}>
            <Text style={styles.zoomTextOn}>와이드</Text>
          </View>
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
