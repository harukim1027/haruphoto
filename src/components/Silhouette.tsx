import React, { useMemo } from 'react';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import type { PoseJoints, Pt } from '../face/types';

type ScreenJoints = Partial<Record<keyof PoseJoints, Pt>>;

/** 점들을 닫힌 path 로 (얼굴 외곽). 점 3개 미만이면 null. */
function closedPath(pts?: Pt[]) {
  if (!pts || pts.length < 3) return null;
  const p = Skia.Path.Make();
  p.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
  p.close();
  return p;
}

/** 관절을 순서대로 이은 열린 path (상체 외곽: 손목-팔꿈치-어깨-목-어깨-팔꿈치-손목). */
function bodyPath(j: ScreenJoints) {
  const order: (keyof PoseJoints)[] = [
    'leftWrist',
    'leftElbow',
    'leftShoulder',
    'neck',
    'rightShoulder',
    'rightElbow',
    'rightWrist',
  ];
  const seq = order.map((k) => j[k]).filter(Boolean) as Pt[];
  if (seq.length < 2) return null;
  const p = Skia.Path.Make();
  p.moveTo(seq[0].x, seq[0].y);
  for (let i = 1; i < seq.length; i++) p.lineTo(seq[i].x, seq[i].y);
  return p;
}

/**
 * 얼굴 외곽 윤곽선 + 상체 외곽선을 화면 좌표로 그린다.
 * face/joints 는 이미 화면 픽셀로 매핑된 좌표. 데이터 없으면 아무것도 안 그림.
 */
export default function Silhouette({
  faceContour,
  bodyOutline,
  joints,
  color,
  fillColor,
  width = 3,
}: {
  faceContour?: Pt[];
  bodyOutline?: Pt[]; // 인물 분할 실루엣(있으면 관절 막대기 대신 이걸 그림)
  joints?: ScreenJoints;
  color: string;
  fillColor?: string; // 있으면 실루엣 내부를 반투명 채움("여기 맞춰라" 가이드)
  width?: number;
}) {
  const face = useMemo(() => closedPath(faceContour), [faceContour]);
  const silhouette = useMemo(() => closedPath(bodyOutline), [bodyOutline]);
  // 실루엣이 있으면 막대기는 생략(자세를 몸 외곽선으로 보여줌)
  const body = useMemo(
    () => (!bodyOutline && joints ? bodyPath(joints) : null),
    [bodyOutline, joints],
  );
  if (!face && !silhouette && !body) return null;
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {silhouette && fillColor && (
        <Path path={silhouette} style="fill" color={fillColor} />
      )}
      {silhouette && (
        <Path
          path={silhouette}
          style="stroke"
          color={color}
          strokeWidth={width}
          strokeJoin="round"
        />
      )}
      {face && (
        <Path
          path={face}
          style="stroke"
          color={color}
          strokeWidth={width}
          strokeJoin="round"
        />
      )}
      {body && (
        <Path
          path={body}
          style="stroke"
          color={color}
          strokeWidth={width}
          strokeCap="round"
          strokeJoin="round"
        />
      )}
    </Canvas>
  );
}
