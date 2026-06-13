import React, { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { extractFaceFromImage } from '../face/extractFaceFromImage';
import {
  mapCover,
  type FaceFeatures,
  type PoseJoints,
  type Pt,
} from '../face/types';
import PoseSkeleton from '../components/PoseSkeleton';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ReferencePick'>;

export default function ReferencePickScreen() {
  const navigation = useNavigation<Nav>();
  const { width } = useWindowDimensions();
  const previewW = width - 40;
  const previewH = (previewW * 4) / 3;

  const [uri, setUri] = useState<string | null>(null);
  const [features, setFeatures] = useState<FaceFeatures | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickImage = async () => {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return;

    const asset = result.assets[0];
    setUri(asset.uri);
    setFeatures(null);
    setBusy(true);
    try {
      const f = await extractFaceFromImage(asset.uri);
      if (f == null) {
        setError('이 사진에서 얼굴을 찾지 못했어요. 얼굴이 또렷한 셀카/상반신 사진으로 시도해보세요.');
      } else {
        setFeatures(f);
      }
    } catch (e) {
      setError('얼굴 분석 중 문제가 생겼어요. 다른 사진으로 시도해보세요.');
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  // 검증용: 랜드마크 점(눈/코/입)을 표시된 이미지(cover) 기준으로 매핑
  const img = features?.imageSize;
  const lm = features?.landmarks;
  const toScreen = (p?: Pt) =>
    p && img ? mapCover(p.x, p.y, img.w, img.h, previewW, previewH) : null;
  const dots: { p: Pt | null; color: string; key: string }[] = [
    { p: toScreen(lm?.leftEye), color: '#00E08A', key: 'le' },
    { p: toScreen(lm?.rightEye), color: '#22D3EE', key: 're' },
    { p: toScreen(lm?.nose), color: '#FFD400', key: 'no' },
    { p: toScreen(lm?.mouth), color: '#FF5A5A', key: 'mo' },
  ];
  // 상체 스켈레톤(자세) — cover 매핑
  const poseScreen: Partial<Record<keyof PoseJoints, Pt>> = {};
  if (features?.pose && img) {
    for (const k of Object.keys(features.pose) as (keyof PoseJoints)[]) {
      const j = features.pose[k];
      if (j && j.c > 0.2) {
        poseScreen[k] = mapCover(j.x, j.y, img.w, img.h, previewW, previewH);
      }
    }
  }
  const hasPose = Object.keys(poseScreen).length > 0;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>레퍼런스 고르기</Text>
      <Text style={styles.desc}>
        따라 찍고 싶은 상반신 사진을 골라주세요. 어깨·팔이 보일수록 자세가 잘 잡혀요.
      </Text>

      <Pressable
        style={[styles.preview, { width: previewW, height: previewH }]}
        onPress={pickImage}
      >
        {uri ? (
          <>
            <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            {hasPose && <PoseSkeleton joints={poseScreen} color="#22D3EE" width={4} />}
            {dots.map(
              (d) =>
                d.p && (
                  <View
                    key={d.key}
                    pointerEvents="none"
                    style={[
                      styles.dot,
                      { left: d.p.x - 7, top: d.p.y - 7, backgroundColor: d.color },
                    ]}
                  />
                ),
            )}
          </>
        ) : (
          <Text style={styles.previewHint}>탭해서 사진 선택</Text>
        )}
        {busy && (
          <View style={styles.busyOverlay}>
            <ActivityIndicator color="#00E08A" size="large" />
            <Text style={styles.busyText}>얼굴 분석 중…</Text>
          </View>
        )}
      </Pressable>

      {features && !error && (
        <Text style={styles.ok}>
          ✓ 얼굴 인식{hasPose ? ' · 상체 자세 인식' : ' (상체가 더 보이면 자세도 잡혀요)'}
        </Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.actions}>
        {uri && (
          <Pressable style={styles.secondary} onPress={pickImage}>
            <Text style={styles.secondaryText}>다른 사진</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.primary, !features && styles.disabled]}
          disabled={!features || !uri}
          onPress={() =>
            uri &&
            features &&
            navigation.navigate('Shoot', {
              referenceUri: uri,
              referenceFeatures: features,
            })
          }
        >
          <Text style={styles.primaryText}>이 자세로 촬영</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D0F', padding: 20 },
  title: { color: '#FFF', fontSize: 22, fontWeight: '700', marginTop: 12 },
  desc: { color: '#8E8E96', fontSize: 13, marginTop: 6, marginBottom: 16 },
  preview: {
    borderRadius: 16,
    backgroundColor: '#1A1A1E',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  previewHint: { color: '#55555E', fontSize: 15 },
  dot: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#000',
  },
  bodyRect: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(34,211,238,0.7)',
    borderRadius: 16,
    borderStyle: 'dashed',
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  busyText: { color: '#FFF', fontSize: 13 },
  ok: { color: '#00E08A', fontSize: 13, marginTop: 12 },
  error: { color: '#FF6B6B', fontSize: 13, marginTop: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 'auto', marginBottom: 24 },
  primary: {
    flex: 1,
    backgroundColor: '#00E08A',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryText: { color: '#0D0D0F', fontSize: 16, fontWeight: '700' },
  secondary: {
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#33333A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: '#FFF', fontSize: 14 },
  disabled: { opacity: 0.35 },
});
