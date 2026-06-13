import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import type { FaceVisionResult } from './types';

// 네이티브 'detectFace' 프레임프로세서 플러그인 (FaceVisionPlugin.swift)
const plugin = VisionCameraProxy.initFrameProcessorPlugin('detectFace', {});

function detectFace(frame: Parameters<Parameters<typeof useFrameProcessor>[0]>[0]) {
  'worklet';
  if (plugin == null) {
    throw new Error('detectFace 네이티브 플러그인을 찾을 수 없습니다');
  }
  return plugin.call(frame) as unknown as FaceVisionResult;
}

/**
 * Apple Vision 스파이크: 카메라에 얼굴 비추고 detectFace 결과(각도/표정/시선) + fps 표시.
 * 매칭/가이드 없이 네이티브 플러그인 동작 + fps 확인용.
 */
export default function FaceVisionSpikeScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [position, setPosition] = useState<CameraPosition>('front');
  const device = useCameraDevice(position);

  const [hud, setHud] = useState<string>('얼굴을 비춰주세요');
  const [fps, setFps] = useState(0);

  const frames = useRef(0);
  const lastTs = useRef(Date.now());
  const lastReport = useSharedValue(0);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const report = useCallback((r: FaceVisionResult) => {
    frames.current += 1;
    const now = Date.now();
    if (now - lastTs.current >= 1000) {
      setFps(frames.current);
      frames.current = 0;
      lastTs.current = now;
    }
    if (!r?.found) {
      setHud('얼굴 없음');
      return;
    }
    const f = (n?: number) => (n ?? 0).toFixed(2);
    const deg = (n?: number) => Math.round(((n ?? 0) * 180) / Math.PI);
    setHud(
      `yaw ${deg(r.yaw)}° pitch ${deg(r.pitch)}° roll ${deg(r.roll)}°\n` +
        `구도 x${f(r.x)} y${f(r.y)} size${f(r.size)}\n` +
        `입벌림 ${f(r.mouthOpen)} 미소 ${f(r.smile)}\n` +
        `눈 L${f(r.leftEyeOpen)} R${f(r.rightEyeOpen)}\n` +
        `시선 x${f(r.gazeX)} y${f(r.gazeY)}`,
    );
  }, []);

  const reportJS = Worklets.createRunOnJS(report);

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      const r = detectFace(frame);
      // 12fps 정도로만 JS 보고 (runOnJS 폭주 방지)
      const now = Date.now();
      if (now - lastReport.value > 80) {
        lastReport.value = now;
        reportJS(r);
      }
    },
    [reportJS],
  );

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>카메라 권한이 필요합니다</Text>
      </View>
    );
  }
  if (device == null) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>카메라를 찾을 수 없습니다</Text>
      </View>
    );
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
        <Text style={styles.fps}>fps {fps} · {position}</Text>
        <Text style={styles.hudText}>{hud}</Text>
      </View>
      <Pressable
        style={styles.toggle}
        onPress={() => setPosition((p) => (p === 'front' ? 'back' : 'front'))}
      >
        <Text style={styles.toggleText}>
          {position === 'front' ? '후면으로' : '전면으로'}
        </Text>
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
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 10,
    padding: 12,
  },
  fps: { color: '#00E08A', fontSize: 18, fontWeight: '700', marginBottom: 4 },
  hudText: { color: '#FFF', fontSize: 13, lineHeight: 19 },
  toggle: {
    position: 'absolute',
    bottom: 44,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  toggleText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
});
