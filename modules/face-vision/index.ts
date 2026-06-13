import { requireNativeModule } from 'expo-modules-core';

// 네이티브 'FaceVision' Expo 모듈 (modules/face-vision/ios/FaceVisionModule.swift)
export interface FaceVisionNative {
  detectOnImage(uri: string): Promise<Record<string, unknown>>;
}

let cached: FaceVisionNative | null = null;

// import 시점이 아니라 호출 시점에 모듈을 찾는다(미등록 시 catch 가능).
export function getFaceVision(): FaceVisionNative {
  if (cached == null) {
    cached = requireNativeModule('FaceVision') as FaceVisionNative;
  }
  return cached;
}
