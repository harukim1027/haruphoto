import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ShotSession } from '../types';

const KEY = 'haruphoto:sessions:v1';

export async function loadSessions(): Promise<ShotSession[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ShotSession[];
  } catch {
    return [];
  }
}

export async function addSession(session: ShotSession): Promise<void> {
  const list = await loadSessions();
  list.unshift(session);
  await AsyncStorage.setItem(KEY, JSON.stringify(list.slice(0, 200)));
}

export async function removeSession(id: string): Promise<void> {
  const list = await loadSessions();
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify(list.filter((s) => s.id !== id)),
  );
}
