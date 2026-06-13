import React from 'react';
import { Canvas, Circle, Line, vec } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import { MIN_CONFIDENCE, POSE_EDGES } from '../pose/skeleton';
import type { PoseArray } from '../types';

interface Props {
  pose: PoseArray; // 정규화 전 원본 (0~1 좌표)
  width: number; // 그릴 영역 크기 (px)
  height: number;
  color?: string;
}

/**
 * 정지 이미지 위에 겹쳐 그리는 스켈레톤.
 * (레퍼런스 확인 화면 / 비교 화면에서 사용)
 */
export default function SkeletonOverlay({
  pose,
  width,
  height,
  color = '#00E08A',
}: Props) {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < 17; i++) {
    points.push({
      x: pose[i * 3 + 1] * width,
      y: pose[i * 3] * height,
    });
  }

  return (
    <Canvas style={[StyleSheet.absoluteFill, { width, height }]}>
      {POSE_EDGES.map(([a, b], idx) => {
        if (
          pose[a * 3 + 2] < MIN_CONFIDENCE ||
          pose[b * 3 + 2] < MIN_CONFIDENCE
        ) {
          return null;
        }
        return (
          <Line
            key={`e${idx}`}
            p1={vec(points[a].x, points[a].y)}
            p2={vec(points[b].x, points[b].y)}
            color="#FFFFFF"
            strokeWidth={3}
          />
        );
      })}
      {points.map((p, i) =>
        pose[i * 3 + 2] >= MIN_CONFIDENCE ? (
          <Circle key={`p${i}`} cx={p.x} cy={p.y} r={5} color={color} />
        ) : null,
      )}
    </Canvas>
  );
}
