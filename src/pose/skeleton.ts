// MoveNet은 COCO 17 키포인트를 (y, x, score) 순으로 출력한다.
// 출력 텐서 shape: [1, 1, 17, 3] (flatten된 1차원 배열로 들어옴)

export const KEYPOINT_NAMES = [
  'nose',          // 0
  'left_eye',      // 1
  'right_eye',     // 2
  'left_ear',      // 3
  'right_ear',     // 4
  'left_shoulder', // 5
  'right_shoulder',// 6
  'left_elbow',    // 7
  'right_elbow',   // 8
  'left_wrist',    // 9
  'right_wrist',   // 10
  'left_hip',      // 11
  'right_hip',     // 12
  'left_knee',     // 13
  'right_knee',    // 14
  'left_ankle',    // 15
  'right_ankle',   // 16
] as const;

// 스켈레톤으로 이을 관절 쌍
export const POSE_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [1, 3], [2, 4],        // 얼굴
  [5, 6],                                 // 어깨
  [5, 7], [7, 9], [6, 8], [8, 10],        // 팔
  [5, 11], [6, 12], [11, 12],             // 몸통
  [11, 13], [13, 15], [12, 14], [14, 16], // 다리
];

// 이 점수 미만 키포인트는 그리지 않음
export const MIN_CONFIDENCE = 0.3;
