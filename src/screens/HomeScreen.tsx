import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { loadSessions } from '../store/sessions';
import type { ShotSession } from '../types';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

export default function HomeScreen() {
  const navigation = useNavigation<Nav>();
  const [sessions, setSessions] = useState<ShotSession[]>([]);

  useFocusEffect(
    useCallback(() => {
      loadSessions().then(setSessions);
    }, []),
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>하루포토</Text>
      <Text style={styles.subtitle}>
        마음에 든 사진처럼, 그대로 찍기
      </Text>

      <Pressable
        style={styles.cta}
        onPress={() => navigation.navigate('ReferencePick')}
      >
        <Text style={styles.ctaText}>레퍼런스 사진 고르기</Text>
      </Pressable>

      {/* Apple Vision 스파이크 진입 (임시) */}
      <Pressable
        style={styles.spike}
        onPress={() => navigation.navigate('FaceVisionSpike')}
      >
        <Text style={styles.spikeText}>🧪 Face Vision 스파이크 (각도/표정/fps)</Text>
      </Pressable>

      <Text style={styles.sectionLabel}>
        {sessions.length > 0 ? '지난 촬영' : ''}
      </Text>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        numColumns={3}
        columnWrapperStyle={styles.row}
        ListEmptyComponent={
          <Text style={styles.empty}>
            아직 촬영 기록이 없어요.{'\n'}레퍼런스를 골라 시작해보세요.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.cell}
            onPress={() =>
              navigation.navigate('Compare', {
                referenceUri: item.referenceUri,
                shotUri: item.shotUri,
                matchScore: item.matchScore,
                fromHistory: true,
              })
            }
          >
            <Image source={{ uri: item.shotUri }} style={styles.thumb} />
            <Text style={styles.score}>
              {Math.round(item.matchScore * 100)}%
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D0F', padding: 20 },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
    marginTop: 48,
  },
  subtitle: { color: '#8E8E96', fontSize: 14, marginTop: 6 },
  cta: {
    backgroundColor: '#00E08A',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 28,
    marginBottom: 32,
  },
  ctaText: { color: '#0D0D0F', fontSize: 16, fontWeight: '700' },
  spike: {
    borderWidth: 1,
    borderColor: '#33333A',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: -16,
    marginBottom: 24,
  },
  spikeText: { color: '#8E8E96', fontSize: 13, fontWeight: '600' },
  sectionLabel: { color: '#8E8E96', fontSize: 13, marginBottom: 12 },
  row: { gap: 8, marginBottom: 8 },
  cell: { flex: 1 / 3, aspectRatio: 3 / 4 },
  thumb: { flex: 1, borderRadius: 8, backgroundColor: '#1A1A1E' },
  score: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    color: '#00E08A',
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  empty: {
    color: '#55555E',
    textAlign: 'center',
    marginTop: 40,
    lineHeight: 22,
  },
});
