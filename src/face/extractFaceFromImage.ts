import { getFaceVision } from '../../modules/face-vision';
import { toFaceFeatures, type FaceFeatures, type FaceVisionResult } from './types';

/**
 * 레퍼런스 정지 사진(file:// 또는 경로)에서 얼굴 특징을 추출.
 * 얼굴을 못 찾으면 null. (Apple Vision, Expo 로컬 모듈)
 */
export async function extractFaceFromImage(
  uri: string,
): Promise<FaceFeatures | null> {
  const result = (await getFaceVision().detectOnImage(
    uri,
  )) as unknown as FaceVisionResult;
  return toFaceFeatures(result);
}
