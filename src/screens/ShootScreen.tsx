import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useSkiaFrameProcessor,
  VisionCameraProxy,
  type CameraPosition,
} from 'react-native-vision-camera';
import { PaintStyle, Skia } from '@shopify/react-native-skia';
import { Worklets, useSharedValue } from 'react-native-worklets-core';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import {
  POSE_EDGES,
  toFaceFeatures,
  type FaceVisionResult,
  type PoseJoints,
} from '../face/types';
import {
  matchFace,
  MATCH_THRESHOLD,
  SHUTTER_COOLDOWN_MS,
  SHUTTER_HOLD_MS,
  type MatchScores,
} from '../face/matchFace';
import { guideText } from '../face/guide';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Shoot'>;
type Rt = RouteProp<RootStackParamList, 'Shoot'>;

const facePlugin = VisionCameraProxy.initFrameProcessorPlugin('detectFace', {});

const JOINT_KEYS: (keyof PoseJoints)[] = [
  'neck',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'root',
];

// 프레임 안에 상체 스켈레톤을 그린다(카메라와 확실히 합성). flip=전면 미러 보정.
function drawSkeleton(
  frame: { drawLine: Function; drawCircle: Function; width: number; height: number },
  pose: PoseJoints,
  flip: boolean,
  linePaint: unknown,
  jointPaint: unknown,
) {
  'worklet';
  const fw = frame.width;
  const fh = frame.height;
  const X = (x: number) => (flip ? 1 - x : x) * fw;
  for (let i = 0; i < POSE_EDGES.length; i++) {
    const a = pose[POSE_EDGES[i][0]];
    const b = pose[POSE_EDGES[i][1]];
    if (a && b && a.c > 0.2 && b.c > 0.2) {
      frame.drawLine(X(a.x), a.y * fh, X(b.x), b.y * fh, linePaint);
    }
  }
  for (let i = 0; i < JOINT_KEYS.length; i++) {
    const j = pose[JOINT_KEYS[i]];
    if (j && j.c > 0.2) frame.drawCircle(X(j.x), j.y * fh, 7, jointPaint);
  }
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

export default function ShootScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { referenceUri, referenceFeatures } = route.params;

  const [position, setPosition] = useState<CameraPosition>('front'); // 전면 기본
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

  // 레퍼런스 자세 데이터 전달 확인용
  const refPose = referenceFeatures.pose;
  const refJointCount = refPose
    ? JOINT_KEYS.filter((k) => refPose[k] && (refPose[k] as { c: number }).c > 0.2).length
    : 0;

  const [scores, setScores] = useState<MatchScores>(ZERO);
  const [guide, setGuide] = useState(
    refJointCount > 0 ? '흰 선에 자세를 맞춰주세요' : '상체가 보이게 서주세요',
  );
  const [hasFace, setHasFace] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const neutral = device?.neutralZoom ?? 1;
  const [zoom, setZoom] = useState(neutral);
  useEffect(() => {
    setZoom(device?.neutralZoom ?? 1);
  }, [device?.neutralZoom, position]);
  const zoomPresets = device
    ? [0.5, 0.6, 0.8, 1, 1.5, 2].filter((m) => {
        const z = neutral * m;
        return z >= device.minZoom - 1e-3 && z <= device.maxZoom + 1e-3;
      })
    : [];

  const highSince = useSharedValue(0);
  const cooldownUntil = useSharedValue(0);
  const lastReport = useSharedValue(0);

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
    (s: MatchScores, g: string, ok: boolean) => {
      setHasFace(ok);
      setScores(ok ? s : ZERO);
      setGuide(g);
    },
  );
  const triggerShutter = Worklets.createRunOnJS(() => capture());

  const frameProcessor = useSkiaFrameProcessor(
    (frame) => {
      'worklet';
      frame.render(); // 카메라 프리뷰

      // ── 목표 자세(레퍼런스): 흰 선 ──
      if (refPose) {
        const tLine = Skia.Paint();
        tLine.setColor(Skia.Color('rgba(255,255,255,0.7)'));
        tLine.setStyle(PaintStyle.Stroke);
        tLine.setStrokeWidth(10);
        const tDot = Skia.Paint();
        tDot.setColor(Skia.Color('rgba(255,255,255,0.85)'));
        // 전면이면 목표를 미러해서 사진과 같은 배치로 보이게
        drawSkeleton(frame, refPose, front, tLine, tDot);
      }

      const raw = facePlugin?.call(frame) as unknown as FaceVisionResult | undefined;
      const live = raw ? toFaceFeatures(raw) : null;
      const now = Date.now();

      if (!live) {
        highSince.value = 0;
        if (now - lastReport.value > 150) {
          lastReport.value = now;
          report(ZERO, '사람이 보이지 않아요', false);
        }
        return;
      }

      const s = matchFace(referenceFeatures, live);
      const allGood =
        (!s.hasPose || s.pose >= MATCH_THRESHOLD) &&
        s.framing >= MATCH_THRESHOLD &&
        s.orientation >= MATCH_THRESHOLD &&
        s.expression >= MATCH_THRESHOLD &&
        s.gaze >= MATCH_THRESHOLD;

      // ── 내 실시간 자세: 가까울수록 초록(노랑→초록) ──
      if (raw?.pose) {
        const t = s.hasPose ? s.pose : s.overall;
        const c = t >= MATCH_THRESHOLD ? '#00E08A' : t >= 0.45 ? '#FFD400' : '#FF8A3D';
        const lLine = Skia.Paint();
        lLine.setColor(Skia.Color(c));
        lLine.setStyle(PaintStyle.Stroke);
        lLine.setStrokeWidth(6);
        const lDot = Skia.Paint();
        lDot.setColor(Skia.Color(c));
        // 라이브는 원본 프레임 좌표(미러 보정 X) — 프리뷰 미러가 사용자 몸에 맞춰줌
        drawSkeleton(frame, raw.pose, false, lLine, lDot);
      }

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
        const g = allGood ? '완벽해요! 그대로!' : guideText(referenceFeatures, live, s);
        report(s, g, true);
      }
    },
    [referenceFeatures, refPose, front, report, triggerShutter],
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

  return (
    <View style={styles.container}>
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

      {/* 큰 가이드 문구 */}
      <View pointerEvents="none" style={styles.guideWrap}>
        <Text style={styles.guideText}>{guide}</Text>
        {refJointCount === 0 && (
          <Text style={styles.warn}>
            이 레퍼런스는 상체가 적게 나와 자세 가이드가 없어요 (얼굴·구도로 맞춰요)
          </Text>
        )}
      </View>

      {/* 일치율 (자세 우선) */}
      <View pointerEvents="none" style={styles.bars}>
        {scores.hasPose && <Bar label="자세" v={scores.pose} big />}
        <Bar label="구도" v={scores.framing} />
        <Bar label="각도" v={scores.orientation} />
        <Bar label="표정" v={scores.expression} />
        <Bar label="시선" v={scores.gaze} />
        <Text style={styles.overall}>종합 {Math.round(scores.overall * 100)}%</Text>
      </View>

      {/* 줌/렌즈 프리셋 */}
      {zoomPresets.length > 1 && (
        <View style={styles.zoomRow}>
          {zoomPresets.map((m) => {
            const active = Math.abs(zoom - neutral * m) < neutral * 0.04;
            return (
              <Pressable
                key={m}
                style={[styles.zoomBtn, active && styles.zoomBtnOn]}
                onPress={() => setZoom(neutral * m)}
              >
                <Text style={[styles.zoomText, active && styles.zoomTextOn]}>
                  {active ? `${m}×` : m}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* 전/후면 토글 */}
      <Pressable
        style={styles.flip}
        onPress={() => setPosition((p) => (p === 'front' ? 'back' : 'front'))}
      >
        <Text style={styles.flipText}>{front ? '후면' : '전면'}</Text>
      </Pressable>

      {/* 수동 셔터 */}
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  centerText: { color: '#fff', fontSize: 16 },
  guideWrap: { position: 'absolute', top: 100, left: 16, right: 16, alignItems: 'center' },
  guideText: {
    color: '#FFF',
    fontSize: 26,
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
