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
import { extractPoseFromImage } from '../pose/extractPose';
import { useMovenetModel } from '../pose/useMovenetModel';
import SkeletonOverlay from '../components/SkeletonOverlay';
import type { PoseArray } from '../types';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ReferencePick'>;

export default function ReferencePickScreen() {
  const navigation = useNavigation<Nav>();
  const { width } = useWindowDimensions();
  const previewW = width - 40;
  const previewH = (previewW * 4) / 3;

  const plugin = useMovenetModel();

  const [uri, setUri] = useState<string | null>(null);
  const [pose, setPose] = useState<PoseArray | null>(null);
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
    setPose(null);

    if (plugin.state !== 'loaded') {
      setError('포즈 모델이 아직 준비되지 않았어요. 잠시 후 다시 시도해주세요.');
      return;
    }

    setBusy(true);
    try {
      const extracted = await extractPoseFromImage(asset.uri, plugin.model);
      if (extracted == null) {
        setError('이 사진에서 사람 포즈를 찾지 못했어요. 전신이나 반신이 나온 사진으로 시도해보세요.');
      } else {
        setPose(extracted);
      }
    } catch (e) {
      setError('포즈 추출 중 문제가 생겼어요. 다른 사진으로 시도해보세요.');
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>레퍼런스 고르기</Text>
      <Text style={styles.desc}>
        따라 찍고 싶은 사진을 골라주세요. 전신/반신 인물 사진일수록 잘 잡혀요.
      </Text>

      <Pressable
        style={[styles.preview, { width: previewW, height: previewH }]}
        onPress={pickImage}
      >
        {uri ? (
          <>
            <Image
              source={{ uri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
            />
            {pose && (
              <SkeletonOverlay
                pose={pose}
                width={previewW}
                height={previewH}
              />
            )}
          </>
        ) : (
          <Text style={styles.previewHint}>탭해서 사진 선택</Text>
        )}
        {busy && (
          <View style={styles.busyOverlay}>
            <ActivityIndicator color="#00E08A" size="large" />
            <Text style={styles.busyText}>포즈 분석 중…</Text>
          </View>
        )}
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.actions}>
        {uri && (
          <Pressable style={styles.secondary} onPress={pickImage}>
            <Text style={styles.secondaryText}>다른 사진</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.primary, !pose && styles.disabled]}
          disabled={!pose || !uri}
          onPress={() =>
            uri &&
            pose &&
            navigation.navigate('Shoot', { referenceUri: uri, referencePose: pose })
          }
        >
          <Text style={styles.primaryText}>이 포즈로 촬영</Text>
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
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  busyText: { color: '#FFF', fontSize: 13 },
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
