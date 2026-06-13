import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  VisionCameraProxy,
  type CameraPosition,
} from 'react-native-vision-camera';
import { Worklets, useSharedValue } from 'react-native-worklets-core';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { toFaceFeatures, type FaceVisionResult } from '../face/types';
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

function detectFace(frame: Parameters<Parameters<typeof useFrameProcessor>[0]>[0]) {
  'worklet';
  if (facePlugin == null) throw new Error('detectFace 네이티브 플러그인 없음');
  return facePlugin.call(frame) as unknown as FaceVisionResult;
}

const ZERO: MatchScores = {
  framing: 0,
  orientation: 0,
  expression: 0,
  gaze: 0,
  overall: 0,
};

export default function ShootScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { referenceUri, referenceFeatures } = route.params;

  const [position, setPosition] = useState<CameraPosition>('front'); // 전면 기본
  const device = useCameraDevice(position);
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);

  const [scores, setScores] = useState<MatchScores>(ZERO);
  const [guide, setGuide] = useState('얼굴을 화면에 맞춰주세요');
  const [hasFace, setHasFace] = useState(false);
  const [capturing, setCapturing] = useState(false);

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
    (s: MatchScores, g: string, face: boolean) => {
      setHasFace(face);
      setScores(face ? s : ZERO);
      setGuide(g);
    },
  );
  const triggerShutter = Worklets.createRunOnJS(() => capture());

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      const raw = detectFace(frame);
      const live = toFaceFeatures(raw);
      const now = Date.now();

      if (live == null) {
        highSince.value = 0;
        if (now - lastReport.value > 150) {
          lastReport.value = now;
          report(ZERO, '얼굴이 보이지 않아요', false);
        }
        return;
      }

      const s = matchFace(referenceFeatures, live);
      const allGood =
        s.framing >= MATCH_THRESHOLD &&
        s.orientation >= MATCH_THRESHOLD &&
        s.expression >= MATCH_THRESHOLD &&
        s.gaze >= MATCH_THRESHOLD;

      // ── 자동 셔터: 4항목 모두 임계 이상을 HOLD 동안 유지 ──
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

      if (now - lastReport.value > 150) {
        lastReport.value = now;
        const g = allGood ? '완벽해요! 그대로!' : guideText(referenceFeatures, live, s);
        report(s, g, true);
      }
    },
    [referenceFeatures, report, triggerShutter],
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

  // 레퍼런스 얼굴 위치 가이드 타원 (전면은 미러라 x 반전)
  const targetX =
    position === 'front' ? 1 - referenceFeatures.framing.cx : referenceFeatures.framing.cx;
  const target = {
    left: `${(targetX - referenceFeatures.framing.size / 2) * 100}%` as const,
    top: `${(referenceFeatures.framing.cy - referenceFeatures.framing.size / 2) * 100}%` as const,
    width: `${referenceFeatures.framing.size * 100}%` as const,
    aspectRatio: 1,
  };

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
      />

      {/* 레퍼런스 얼굴 위치 가이드 */}
      <View pointerEvents="none" style={[styles.target, target, hasFace && styles.targetOn]} />

      {/* ── 핵심: 큰 가이드 문구 ── */}
      <View pointerEvents="none" style={styles.guideWrap}>
        <Text style={styles.guideText}>{guide}</Text>
      </View>

      {/* 4분할 일치율 */}
      <View pointerEvents="none" style={styles.bars}>
        <Bar label="구도" v={scores.framing} />
        <Bar label="각도" v={scores.orientation} />
        <Bar label="표정" v={scores.expression} />
        <Bar label="시선" v={scores.gaze} />
        <Text style={styles.overall}>종합 {Math.round(scores.overall * 100)}%</Text>
      </View>

      {/* 전/후면 토글 */}
      <Pressable
        style={styles.flip}
        onPress={() => setPosition((p) => (p === 'front' ? 'back' : 'front'))}
      >
        <Text style={styles.flipText}>{position === 'front' ? '후면' : '전면'}</Text>
      </Pressable>

      {/* 수동 셔터 (백업) */}
      <Pressable style={styles.shutter} onPress={capture} disabled={capturing}>
        <View style={styles.shutterInner} />
      </Pressable>
    </View>
  );
}

function Bar({ label, v }: { label: string; v: number }) {
  const ok = v >= MATCH_THRESHOLD;
  return (
    <View style={styles.barRow}>
      <Text style={styles.barLabel}>{label}</Text>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
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
  target: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.5)',
    borderRadius: 999,
  },
  targetOn: { borderColor: 'rgba(0,224,138,0.9)' },
  guideWrap: {
    position: 'absolute',
    top: 120,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
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
  bars: {
    position: 'absolute',
    bottom: 130,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { color: '#FFF', fontSize: 13, width: 32 },
  barTrack: {
    flex: 1,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: { height: 8, borderRadius: 4 },
  barPct: { color: '#FFF', fontSize: 12, width: 26, textAlign: 'right' },
  overall: { color: '#00E08A', fontSize: 14, fontWeight: '700', marginTop: 4 },
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
