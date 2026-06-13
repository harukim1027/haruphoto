import React, { useEffect, useRef, useState } from 'react';
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
  type CameraPosition,
} from 'react-native-vision-camera';
import { Worklets, useSharedValue } from 'react-native-worklets-core';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import {
  toFaceFeatures,
  type FaceVisionResult,
  type PoseJoints,
  type Pt,
} from '../face/types';
import {
  matchFace,
  MATCH_THRESHOLD,
  SHUTTER_COOLDOWN_MS,
  SHUTTER_HOLD_MS,
  type MatchScores,
} from '../face/matchFace';
import { guideText } from '../face/guide';
import PoseSkeleton from '../components/PoseSkeleton';
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
  pose: 0,
  framing: 0,
  expression: 0,
  gaze: 0,
  orientation: 0,
  hasPose: false,
  overall: 0,
};

// 관절(top-left 정규화, mirror 보정됨) → 화면 픽셀. 전면은 미러 프리뷰라 x 다시 반전.
function poseToScreen(
  pose: PoseJoints | undefined,
  front: boolean,
  w: number,
  h: number,
): Partial<Record<keyof PoseJoints, Pt>> {
  const out: Partial<Record<keyof PoseJoints, Pt>> = {};
  if (!pose) return out;
  for (const k of Object.keys(pose) as (keyof PoseJoints)[]) {
    const j = pose[k];
    if (j && j.c > 0.2) {
      out[k] = { x: (front ? 1 - j.x : j.x) * w, y: j.y * h };
    }
  }
  return out;
}

export default function ShootScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { referenceUri, referenceFeatures } = route.params;
  const { width: W, height: H } = useWindowDimensions();

  const [position, setPosition] = useState<CameraPosition>('front'); // 전면 기본
  const device = useCameraDevice(position);
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const front = position === 'front';

  const [scores, setScores] = useState<MatchScores>(ZERO);
  const [guide, setGuide] = useState('상체가 보이게 서주세요');
  const [hasFace, setHasFace] = useState(false);
  const [livePose, setLivePose] = useState<PoseJoints | undefined>(undefined);
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
    (s: MatchScores, g: string, ok: boolean, pose?: PoseJoints) => {
      setHasFace(ok);
      setScores(ok ? s : ZERO);
      setGuide(g);
      setLivePose(pose);
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
          report(ZERO, '사람이 보이지 않아요', false, undefined);
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
        report(s, g, true, live.pose);
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

  // 목표(레퍼런스) 상체 스켈레톤 + 실시간 스켈레톤 → 화면 좌표
  const targetPose = poseToScreen(referenceFeatures.pose, front, W, H);
  const livePoseScreen = poseToScreen(livePose, front, W, H);
  const hasTargetPose = Object.keys(targetPose).length > 0;

  // 레퍼런스 얼굴 위치 가이드 타원
  const targetX = front ? 1 - referenceFeatures.framing.cx : referenceFeatures.framing.cx;
  const faceTarget = {
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

      {/* 목표 자세 (반투명 흰색) */}
      {hasTargetPose && (
        <PoseSkeleton joints={targetPose} color="rgba(255,255,255,0.55)" width={6} />
      )}
      {/* 내 실시간 자세 (초록) */}
      {Object.keys(livePoseScreen).length > 0 && (
        <PoseSkeleton joints={livePoseScreen} color="#00E08A" width={4} />
      )}

      {/* 레퍼런스 얼굴 위치 가이드 */}
      <View pointerEvents="none" style={[styles.faceTarget, faceTarget, hasFace && styles.faceTargetOn]} />

      {/* ── 핵심: 큰 가이드 문구 ── */}
      <View pointerEvents="none" style={styles.guideWrap}>
        <Text style={styles.guideText}>{guide}</Text>
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
  faceTarget: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
    borderRadius: 999,
  },
  faceTargetOn: { borderColor: 'rgba(0,224,138,0.8)' },
  guideWrap: {
    position: 'absolute',
    top: 110,
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
