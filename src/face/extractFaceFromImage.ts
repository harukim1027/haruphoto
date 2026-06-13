import { NativeModules } from 'react-native';
import { toFaceFeatures, type FaceFeatures, type FaceVisionResult } from './types';

const { FaceVisionModule } = NativeModules as {
  FaceVisionModule?: { detectOnImage(uri: string): Promise<FaceVisionResult> };
};

/**
 * 레퍼런스 정지 사진(file:// 또는 경로)에서 얼굴 특징을 추출.
 * 얼굴을 못 찾으면 null.
 */
export async function extractFaceFromImage(
  uri: string,
): Promise<FaceFeatures | null> {
  if (!FaceVisionModule) {
    throw new Error('FaceVisionModule 네이티브 모듈을 찾을 수 없습니다');
  }
  const result = await FaceVisionModule.detectOnImage(uri);
  return toFaceFeatures(result);
}
