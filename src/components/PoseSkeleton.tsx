import React from 'react';
import { Canvas, Circle, Line, vec } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import { POSE_EDGES, type PoseJoints, type Pt } from '../face/types';

type ScreenJoints = Partial<Record<keyof PoseJoints, Pt>>;

/**
 * 상체 스켈레톤(어깨/팔/몸통 선 + 관절점)을 화면 좌표로 그린다.
 * joints: 이미 화면 픽셀로 매핑된 관절 위치.
 */
export default function PoseSkeleton({
  joints,
  color,
  width = 4,
}: {
  joints: ScreenJoints;
  color: string;
  width?: number;
}) {
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {POSE_EDGES.map(([a, b], i) => {
        const pa = joints[a];
        const pb = joints[b];
        if (!pa || !pb) return null;
        return (
          <Line
            key={`e${i}`}
            p1={vec(pa.x, pa.y)}
            p2={vec(pb.x, pb.y)}
            color={color}
            strokeWidth={width}
            strokeCap="round"
          />
        );
      })}
      {(Object.keys(joints) as (keyof PoseJoints)[]).map((k) => {
        const p = joints[k];
        if (!p) return null;
        return <Circle key={k} cx={p.x} cy={p.y} r={width + 1} color={color} />;
      })}
    </Canvas>
  );
}
