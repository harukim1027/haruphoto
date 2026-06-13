import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useSkiaFrameProcessor,
} from 'react-native-vision-camera';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import { PaintStyle, Skia } from '@shopify/react-native-skia';
import { Worklets, useSharedValue } from 'react-native-worklets-core';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { MIN_CONFIDENCE, POSE_EDGES } from '../pose/skeleton';
import { useMovenetModel } from '../pose/useMovenetModel';
import {
  SHUTTER_COOLDOWN_MS,
  SHUTTER_HOLD_MS,
  SHUTTER_THRESHOLD,
  normalizePose,
  poseSimilarity,
} from '../pose/matchPose';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Shoot'>;
type Rt = RouteProp<RootStackParamList, 'Shoot'>;

const MODEL_INPUT_SIZE = 192;

export default function ShootScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { referenceUri, referencePose } = route.params;

  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);

  const [matchPct, setMatchPct] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);

  const plugin = useMovenetModel();
  const model = plugin.state === 'loaded' ? plugin.model : undefined;
  const { resize } = useResizePlugin();

  // 레퍼런스 포즈는 미리 정규화해서 워크릿에 캡처
  const normalizedRef = normalizePose(referencePose);

  // 자동 셔터 상태 (워크릿 내부 추적)
  const highSinceTs = useSharedValue(0);
  const cooldownUntil = useSharedValue(0);
  const lastUiReportTs = useSharedValue(0);

  const reportMatch = Worklets.createRunOnJS((pct: number) =>
    setMatchPct(pct),
  );
  const triggerShutter = Worklets.createRunOnJS(() => capture());

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const capture = async () => {
    if (capturing || cameraRef.current == null) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePhoto();
      const shotUri = `file://${photo.path}`;
      navigation.replace('Compare', {
        referenceUri,
        shotUri,
        matchScore: (matchPct ?? 0) / 100,
        fromHistory: false,
      });
    } catch (e) {
      console.error('촬영 실패', e);
      setCapturing(false);
    }
  };

  const frameProcessor = useSkiaFrameProcessor(
    (frame) => {
      'worklet';
      frame.render();
      if (model == null) return;

      // ── 레퍼런스 스켈레톤 (반투명 가이드) ──
      const guidePaint = Skia.Paint();
      guidePaint.setColor(Skia.Color('rgba(255,255,255,0.45)'));
      guidePaint.setStyle(PaintStyle.Stroke);
      guidePaint.setStrokeWidth(5);

      for (const [a, b] of POSE_EDGES) {
        if (
          referencePose[a * 3 + 2] < MIN_CONFIDENCE ||
          referencePose[b * 3 + 2] < MIN_CONFIDENCE
        ) {
          continue;
        }
        frame.drawLine(
          referencePose[a * 3 + 1] * frame.width,
          referencePose[a * 3] * frame.height,
          referencePose[b * 3 + 1] * frame.width,
          referencePose[b * 3] * frame.height,
          guidePaint,
        );
      }

      // ── 실시간 포즈 추정 ──
      const input = resize(frame, {
        scale: { width: MODEL_INPUT_SIZE, height: MODEL_INPUT_SIZE },
        pixelFormat: 'rgb',
        dataType: 'uint8',
      });
      const outputs = model.runSync([input]);
      const kp = outputs[0];

      // 내 스켈레톤 (초록)
      const livePaint = Skia.Paint();
      livePaint.setColor(Skia.Color('#00E08A'));
      livePaint.setStyle(PaintStyle.Stroke);
      livePaint.setStrokeWidth(4);

      for (const [a, b] of POSE_EDGES) {
        const sa = Number(kp[a * 3 + 2]);
        const sb = Number(kp[b * 3 + 2]);
        if (sa < MIN_CONFIDENCE || sb < MIN_CONFIDENCE) continue;
        frame.drawLine(
          Number(kp[a * 3 + 1]) * frame.width,
          Number(kp[a * 3]) * frame.height,
          Number(kp[b * 3 + 1]) * frame.width,
          Number(kp[b * 3]) * frame.height,
          livePaint,
        );
      }

      // ── 일치율 계산 ──
      if (normalizedRef == null) return;
      const normalizedLive = normalizePose(kp);
      if (normalizedLive == null) {
        highSinceTs.value = 0;
        return;
      }

      const score = poseSimilarity(normalizedRef, normalizedLive);
      const now = Date.now();

      // UI 갱신은 150ms 간격으로 (runOnJS 폭주 방지)
      if (score >= 0 && now - lastUiReportTs.value > 150) {
        lastUiReportTs.value = now;
        reportMatch(Math.round(score * 100));
      }

      // ── 자동 셔터: 임계치 이상을 SHUTTER_HOLD_MS 유지하면 발동 ──
      if (now < cooldownUntil.value) return;
      if (score >= SHUTTER_THRESHOLD) {
        if (highSinceTs.value === 0) highSinceTs.value = now;
        if (now - highSinceTs.value >= SHUTTER_HOLD_MS) {
          highSinceTs.value = 0;
          cooldownUntil.value = now + SHUTTER_COOLDOWN_MS;
          triggerShutter();
        }
      } else {
        highSinceTs.value = 0;
      }
    },
    [model, referencePose, normalizedRef],
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

  const matched = matchPct != null && matchPct >= SHUTTER_THRESHOLD * 100;

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

      {/* 일치율 HUD */}
      <View style={[styles.hud, matched && styles.hudMatched]}>
        <Text style={[styles.hudText, matched && styles.hudTextMatched]}>
          {matchPct == null ? '포즈를 잡는 중…' : `일치율 ${matchPct}%`}
        </Text>
        {matched && <Text style={styles.hudSub}>그대로! 곧 찍혀요</Text>}
      </View>

      {/* 수동 셔터 (백업) */}
      <Pressable style={styles.shutter} onPress={capture} disabled={capturing}>
        <View style={styles.shutterInner} />
      </Pressable>
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
  hud: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
  },
  hudMatched: { backgroundColor: 'rgba(0,224,138,0.85)' },
  hudText: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  hudTextMatched: { color: '#0D0D0F' },
  hudSub: { color: '#0D0D0F', fontSize: 12, marginTop: 2 },
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
  shutterInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FFF',
  },
});
