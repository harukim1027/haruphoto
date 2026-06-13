import React, { useEffect, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { addSession } from '../store/sessions';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Compare'>;
type Rt = RouteProp<RootStackParamList, 'Compare'>;

export default function CompareScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { referenceUri, shotUri, matchScore, fromHistory } = route.params;
  const { width } = useWindowDimensions();

  const [saved, setSaved] = useState(fromHistory);

  // 새 촬영이면: 앱 문서 폴더로 복사 후 보관함에 기록
  useEffect(() => {
    if (fromHistory) return;
    (async () => {
      try {
        const id = `${Date.now()}`;
        const dest = `${FileSystem.documentDirectory}shot_${id}.jpg`;
        await FileSystem.copyAsync({ from: shotUri, to: dest });
        await addSession({
          id,
          referenceUri,
          shotUri: dest,
          matchScore,
          createdAt: Date.now(),
        });
      } catch (e) {
        console.error('보관함 저장 실패', e);
      }
    })();
  }, [fromHistory, referenceUri, shotUri, matchScore]);

  const saveToGallery = async () => {
    const { granted } = await MediaLibrary.requestPermissionsAsync();
    if (!granted) return;
    await MediaLibrary.saveToLibraryAsync(shotUri);
    setSaved(true);
  };

  const half = (width - 52) / 2;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        일치율 {Math.round(matchScore * 100)}%
      </Text>

      <View style={styles.pair}>
        <View>
          <Image
            source={{ uri: referenceUri }}
            style={[styles.photo, { width: half, height: (half * 4) / 3 }]}
          />
          <Text style={styles.label}>레퍼런스</Text>
        </View>
        <View>
          <Image
            source={{ uri: shotUri }}
            style={[styles.photo, { width: half, height: (half * 4) / 3 }]}
          />
          <Text style={styles.label}>내 사진</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={styles.secondary}
          onPress={() => navigation.popToTop()}
        >
          <Text style={styles.secondaryText}>홈으로</Text>
        </Pressable>
        <Pressable
          style={[styles.primary, saved && styles.disabled]}
          onPress={saveToGallery}
          disabled={saved}
        >
          <Text style={styles.primaryText}>
            {saved ? '저장됨' : '갤러리에 저장'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D0F', padding: 20 },
  title: {
    color: '#00E08A',
    fontSize: 24,
    fontWeight: '700',
    marginTop: 24,
    textAlign: 'center',
  },
  pair: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    marginTop: 24,
  },
  photo: { borderRadius: 12, backgroundColor: '#1A1A1E' },
  label: {
    color: '#8E8E96',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
  },
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
    paddingHorizontal: 24,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#33333A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: '#FFF', fontSize: 14 },
  disabled: { opacity: 0.5 },
});
