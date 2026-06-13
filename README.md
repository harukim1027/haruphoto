# 하루포토 (HaruPhoto) — 기술 스파이크

목표: 실기기에서 카메라 프리뷰 위에 실시간 포즈 스켈레톤을 그리고, 15fps 이상 나오는지 확인한다.
이게 통과하면 본 개발 go, 아니면 재검토.

## 0. 전제

- 실기기(iPhone) 필수. 시뮬레이터는 카메라가 없음.
- Expo Go로는 안 됨. 네이티브 모듈(VisionCamera 등) 때문에 dev client 빌드 필요.

## 1. 프로젝트 생성

```bash
npx create-expo-app haruphoto --template blank-typescript
cd haruphoto
```

## 2. 이 폴더의 파일 복사

`App.tsx`, `app.json`, `babel.config.js`, `metro.config.js`, `.gitignore`, `src/` 를
생성된 프로젝트에 덮어쓰기.

## 3. 의존성 설치

```bash
npx expo install react-native-vision-camera react-native-reanimated @shopify/react-native-skia expo-dev-client
npm i react-native-fast-tflite react-native-worklets-core vision-camera-resize-plugin
```

## 4. 포즈 모델 다운로드

MoveNet SinglePose Lightning (TFLite, int8 양자화) 모델을 받아서
`assets/movenet_lightning.tflite` 로 저장.

- https://www.kaggle.com/models/google/movenet/tfLite/singlepose-lightning-tflite-int8
  (Kaggle 로그인 필요. 다운로드 후 파일명만 위처럼 변경)
- 입력: 192×192×3 uint8 / 출력: [1,1,17,3] float32 (y, x, score)

## 5. 빌드 & 실행

```bash
npx expo prebuild -p ios
npx expo run:ios --device
```

`app.json`의 `ios.bundleIdentifier`는 placeholder니까 본인 걸로 교체.
(번들 ID·팀 ID·서명 정보는 커밋 전 .gitignore 확인 — eas.json, .env 는 이미 ignore에 포함)

## 6. 합격 기준

화면 좌상단 HUD에 fps가 뜬다.

- 사람을 비추면 초록 점 + 흰 선 스켈레톤이 따라온다
- fps ≥ 15 → **GO** (오버레이/일치율 개발 진행)
- fps < 10 → 모델을 더 줄이거나(MoveNet Thunder ❌, Lightning 유지) 프레임 스킵 전략 검토

## 알려진 함정 (스파이크에서 시간 잡아먹는 곳)

1. **스켈레톤이 90도 돌아가 보임** → 기기 방향에 따라 프레임이 landscape로 들어오는 경우.
   `PoseCameraScreen.tsx`의 좌표 계산에서 x/y를 스왑해볼 것 (주석 표시해둠).
2. **모델 로딩 실패** → metro.config.js에 `tflite` assetExts 추가했는지 확인.
3. **빌드 에러: worklets** → babel.config.js 플러그인 순서 확인
   (worklets-core 먼저, reanimated 마지막).
4. **프레임 프로세서가 아예 안 불림** → Expo Go로 실행한 경우. dev client로 다시.

## 2단계: 앱 본체 (이 폴더에 포함됨)

스파이크 검증과 별개로, 전체 플로우가 이미 구현되어 있다:

```
Home(보관함) → ReferencePick(사진 선택+포즈 추출) → Shoot(가이드 오버레이+일치율+자동셔터) → Compare(나란히 비교+저장)
```

추가 의존성:

```bash
npx expo install expo-image-picker expo-media-library expo-file-system \
  @react-native-async-storage/async-storage react-native-screens react-native-safe-area-context
npm i @react-navigation/native @react-navigation/native-stack
```

권한: app.json plugins에 expo-image-picker / expo-media-library 권한 문구가 포함돼 있음.

핵심 파일:
- `src/pose/matchPose.ts` — 골반 원점·몸통 길이 정규화 후 코사인 유사도. 워크릿 호환.
- `src/pose/extractPose.ts` — 정지 사진 → Skia 오프스크린 리사이즈 → MoveNet.
  ⚠️ Skia 버전에 따라 `Surface.MakeOffscreen` / `readPixels` 시그니처가 다를 수 있는
  유일한 파일. 빌드 에러 시 여기부터.
- `src/screens/ShootScreen.tsx` — 자동 셔터 로직: 일치율 92% 이상을 0.6초 유지하면
  촬영, 이후 3초 쿨다운. 임계치는 matchPose.ts 상수로 조절.

수동 셔터 버튼이 백업으로 항상 떠 있으니, 자동 셔터 튜닝 전에도 전체 플로우 테스트 가능.

## 검증 순서 (추천)

1. PoseCameraScreen(스파이크)으로 fps 확인 — App.tsx에서 잠시 entry를 바꿔 단독 실행 가능
2. 통과하면 본체 플로우로 전환해 레퍼런스 → 촬영 → 비교 한 바퀴
3. 자동 셔터 임계치/유지시간 튜닝 (실사용 감도가 핵심)
