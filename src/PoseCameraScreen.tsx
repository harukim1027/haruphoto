import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useSkiaFrameProcessor,
} from 'react-native-vision-camera';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import { PaintStyle, Skia } from '@shopify/react-native-skia';
import { Worklets, useSharedValue } from 'react-native-worklets-core';
import { MIN_CONFIDENCE, POSE_EDGES } from './pose/skeleton';
import { useMovenetModel } from './pose/useMovenetModel';

const MODEL_INPUT_SIZE = 192; // MoveNet Lightning 입력 크기
const NUM_KEYPOINTS = 17;

export default function PoseCameraScreen() {
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const [fps, setFps] = useState(0);

  // 모델 로드 (assets/movenet_lightning.tflite — README 4번 참고)
  const plugin = useMovenetModel();
  const model = plugin.state === 'loaded' ? plugin.model : undefined;

  const { resize } = useResizePlugin();

  // 워크릿 ↔ JS 간 FPS 집계
  const frameCount = useSharedValue(0);
  const lastReportTs = useSharedValue(0);
  const reportFps = Worklets.createRunOnJS((n: number) => setFps(n));

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const frameProcessor = useSkiaFrameProcessor(
    (frame) => {
      'worklet';
      frame.render(); // 카메라 프리뷰 먼저 그림

      if (model == null) return;

      // 1) 프레임을 모델 입력 크기로 리사이즈 (int8 모델 → uint8 입력)
      const input = resize(frame, {
        scale: { width: MODEL_INPUT_SIZE, height: MODEL_INPUT_SIZE },
        pixelFormat: 'rgb',
        dataType: 'uint8',
      });

      // 2) 추론. 출력: [1,1,17,3] flatten → (y, x, score) × 17
      const outputs = model.runSync([input]);
      const kp = outputs[0];

      // 3) 스켈레톤 드로잉
      // ⚠️ 기기 방향에 따라 프레임이 가로로 들어와 스켈레톤이 90도
      //    돌아 보이면, 아래 x/y 계산을 서로 스왑해서 확인할 것.
      const pointPaint = Skia.Paint();
      pointPaint.setColor(Skia.Color('#00E08A'));

      const linePaint = Skia.Paint();
      linePaint.setColor(Skia.Color('#FFFFFF'));
      linePaint.setStyle(PaintStyle.Stroke);
      linePaint.setStrokeWidth(4);

      for (const [a, b] of POSE_EDGES) {
        const sa = Number(kp[a * 3 + 2]);
        const sb = Number(kp[b * 3 + 2]);
        if (sa < MIN_CONFIDENCE || sb < MIN_CONFIDENCE) continue;
        frame.drawLine(
          Number(kp[a * 3 + 1]) * frame.width,
          Number(kp[a * 3]) * frame.height,
          Number(kp[b * 3 + 1]) * frame.width,
          Number(kp[b * 3]) * frame.height,
          linePaint,
        );
      }

      for (let i = 0; i < NUM_KEYPOINTS; i++) {
        const score = Number(kp[i * 3 + 2]);
        if (score < MIN_CONFIDENCE) continue;
        const x = Number(kp[i * 3 + 1]) * frame.width;
        const y = Number(kp[i * 3]) * frame.height;
        frame.drawCircle(x, y, 8, pointPaint);
      }

      // 4) FPS 집계 (1초마다 JS로 보고)
      frameCount.value += 1;
      const now = Date.now();
      if (lastReportTs.value === 0) lastReportTs.value = now;
      if (now - lastReportTs.value >= 1000) {
        reportFps(frameCount.value);
        frameCount.value = 0;
        lastReportTs.value = now;
      }
    },
    [model],
  );

  if (!hasPermission) {
    return <CenterMessage text="카메라 권한이 필요합니다" />;
  }
  if (device == null) {
    return <CenterMessage text="후면 카메라를 찾을 수 없습니다" />;
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        frameProcessor={frameProcessor}
        pixelFormat="yuv"
      />
      <View style={styles.hud}>
        <Text style={styles.hudText}>
          {plugin.state === 'loaded'
            ? `${fps} fps`
            : plugin.state === 'error'
              ? '모델 로드 실패'
              : '모델 로딩 중…'}
        </Text>
      </View>
    </View>
  );
}

function CenterMessage({ text }: { text: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.centerText}>{text}</Text>
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
    left: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  hudText: { color: '#00E08A', fontSize: 16, fontWeight: '600' },
});
