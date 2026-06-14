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
  normalizeSilhouette,
  silhouetteIoU,
  placeUnit,
  POSE_IOU_GOOD,
} from '../face/silhouette';
import { Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import type { RootStackParamList } from '../../App';

// 화면 픽셀 점들 → 닫힌 Skia path.
function mkClosed(pts: Pt[] | null | undefined) {
  if (!pts || pts.length < 3) return null;
  const p = Skia.Path.Make();
  p.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
  p.close();
  return p;
}

type Nav = NativeStackNavigationProp<RootStackParamList, 'Shoot'>;
type Rt = RouteProp<RootStackParamList, 'Shoot'>;

const facePlugin = VisionCameraProxy.initFrameProcessorPlugin('detectFace', {});

const ZOOM_PRESETS = [0.5, 0.6, 0.8, 0.9, 1, 1.5, 2];
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

  const refImg = referenceFeatures.imageSize ?? { w: 3, h: 4 };
  // 레퍼런스 실루엣을 인물 bbox 기준 단위정사각형으로 1회 정규화(캐싱).
  const refUnitSil = useMemo(
    () => normalizeSilhouette(referenceFeatures.bodyOutline, refImg.w, refImg.h),
    [referenceFeatures.bodyOutline, refImg.w, refImg.h],
  );
  const hasRefSil = !!refUnitSil && refUnitSil.length >= 3;

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
      if (device) setZoom(clamp(startZoom.current * e.scale, device.minZoom, device.maxZoom));
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
      // 실루엣 IoU(주력 매칭) — 레퍼런스/라이브를 각자 bbox 기준 정규화 후 겹침 비교.
      const lw = Math.min(frame.width, frame.height);
      const lh = Math.max(frame.width, frame.height);
      const liveUnit = normalizeSilhouette(lf.bodyOutline, lw, lh);
      const iou = hasRefSil ? silhouetteIoU(refUnitSil, liveUnit) : 0;
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
    [referenceFeatures, refUnitSil, hasRefSil, report, reportDiag, triggerShutter],
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

  // 레퍼런스(고정 목표)·라이브 실루엣을 같은 단위정사각형 → 화면 타깃에 배치.
  const liveUnitSil = live
    ? normalizeSilhouette(
        live.bodyOutline,
        Math.min(live.fw, live.fh),
        Math.max(live.fw, live.fh),
      )
    : null;
  const refPath = mkClosed(placeUnit(refUnitSil, W, H));
  const livePath = mkClosed(placeUnit(liveUnitSil, W, H));
  const iouVal = live?.iou ?? 0;
  const iouColor =
    iouVal >= POSE_IOU_GOOD
      ? '#00E08A'
      : iouVal >= 0.3
        ? '#FFD400'
        : 'rgba(255,255,255,0.9)';
  const iouFill =
    iouVal >= POSE_IOU_GOOD ? 'rgba(0,224,138,0.22)' : 'rgba(255,255,255,0.18)';

  return (
    <View style={styles.container}>
      <GestureDetector gesture={pinch}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={!capturing}
          photo
          frameProcessor={frameProcessor}
          pixelFormat="yuv"
          zoom={zoom}
        />
      </GestureDetector>

      {/* 실루엣 오버레이 — 단일 Canvas. 마젠타 마커=Canvas 렌더 확인용. */}
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <Circle cx={24} cy={H * 0.4} r={12} color="magenta" />
        {refPath && iouFill && (
          <Path path={refPath} style="fill" color={iouFill} />
        )}
        {refPath && (
          <Path
            path={refPath}
            style="stroke"
            color={iouColor}
            strokeWidth={4}
            strokeJoin="round"
          />
        )}
        {livePath && (
          <Path
            path={livePath}
            style="stroke"
            color="#00E08A"
            strokeWidth={2}
            strokeJoin="round"
          />
        )}
      </Canvas>

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
            {'\n'}lenses=[{device.physicalDevices.join(',')}]
            {'\n'}presets={presets.join('/')} ultraWide={device.minZoom < 1 ? 'Y' : 'N'}
            {'\n'}FACE found={diag?.found ? 'Y' : 'N'} 실루엣={diag?.silN ?? 0} refSil=
            {hasRefSil ? refUnitSil!.length : 0} IoU={Math.round(iouVal * 100)}{' '}
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

      {presets.length > 1 && (
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
