// 포즈 1개 = 키포인트 17개 × (y, x, score) flatten = 길이 51 배열
export type PoseArray = number[];

export interface ShotSession {
  id: string;
  referenceUri: string; // 레퍼런스 사진
  shotUri: string; // 촬영 결과
  matchScore: number; // 촬영 시점 일치율 (0~1)
  createdAt: number;
}
