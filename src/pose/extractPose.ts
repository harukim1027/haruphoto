import { Skia, AlphaType, ColorType } from '@shopify/react-native-skia';
import type { TensorflowModel } from 'react-native-fast-tflite';
import type { PoseArray } from '../types';

const SIZE = 192; // MoveNet Lightning 입력

/**
 * 갤러리에서 고른 정지 사진 1장에서 포즈를 추출한다.
 *
 * 흐름: 이미지 디코드 → 192×192 오프스크린 캔버스에 그림(=리사이즈)
 *       → RGBA 픽셀 읽기 → RGB로 변환 → MoveNet 추론
 *
 * ⚠️ Skia 버전에 따라 readPixels/Surface API 시그니처가 다를 수 있음.
 *    빌드 에러가 나면 이 파일부터 의심할 것 (README '함정' 참고).
 */
export async function extractPoseFromImage(
  uri: string,
  model: TensorflowModel,
): Promise<PoseArray | null> {
  // 1) 디코드
  const data = await Skia.Data.fromURI(uri);
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (image == null) return null;

  // 2) 192×192로 리사이즈 (비율 무시 stretch — 모델 학습 방식과 동일)
  const surface = Skia.Surface.MakeOffscreen(SIZE, SIZE);
  if (surface == null) return null;

  const canvas = surface.getCanvas();
  const paint = Skia.Paint();
  canvas.drawImageRect(
    image,
    Skia.XYWHRect(0, 0, image.width(), image.height()),
    Skia.XYWHRect(0, 0, SIZE, SIZE),
    paint,
  );

  const snapshot = surface.makeImageSnapshot();
  const pixels = snapshot.readPixels(0, 0, {
    width: SIZE,
    height: SIZE,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  if (pixels == null) return null;

  // 3) RGBA → RGB (uint8)
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  const rgba = pixels as Uint8Array;
  for (let i = 0, j = 0; i < SIZE * SIZE; i++) {
    rgb[j++] = rgba[i * 4];
    rgb[j++] = rgba[i * 4 + 1];
    rgb[j++] = rgba[i * 4 + 2];
  }

  // 4) 추론 → (y, x, score) × 17
  const outputs = model.runSync([rgb]);
  const kp = outputs[0];

  const pose: PoseArray = new Array(17 * 3);
  for (let i = 0; i < 17 * 3; i++) pose[i] = Number(kp[i]);
  return pose;
}
