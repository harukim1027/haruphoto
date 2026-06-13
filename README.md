# 하루포토 (HaruPhoto)

> 인플루언서 셀카 같은 사진을, 그 **각도·구도·표정·시선** 그대로 따라 찍게 해주는 카메라 앱.

레퍼런스 사진 1장을 고르면, 카메라가 실시간으로 얼굴의 구도/각도/표정/시선을 분석해
4분할 일치율과 코칭을 보여주고, 다 맞으면 자동으로 촬영한다.

흐름: **홈(보관함) → 레퍼런스 선택 → 촬영(가이드+실시간 일치율) → 비교·저장**

---

## ⚠️ 스택이 특수하다 — 읽고 시작할 것

이 프로젝트는 일반적인 최신 Expo 템플릿과 **의도적으로 다른** 버전에 고정돼 있다.
아래 결정들은 긴 디버깅 끝에 내려진 것이라, **함부로 올리면 앱이 실행조차 안 된다.**

### 1. Expo **SDK 52 (RN 0.76)** 고정 — 업그레이드 금지
- Expo **SDK 54+** 는 React Native iOS를 **precompiled XCFramework**로 배포하는데, 이게
  최신 **Xcode 26.x와 glog ABI가 불일치**해서 **어떤 JS 번들도 실행 즉시 크래시**한다
  (`ReactInstance.cpp` 에서 `google::LogMessage` → `abort`).
- **SDK 52/53은 React를 소스에서 빌드**하므로(= 당신의 Xcode로 컴파일) 이 크래시가 없다.
- 그래서 SDK 52(RN 0.76, React 18.3)에 고정. **올리지 말 것.**

### 2. `react-native-mediapipe` 사용 불가 — Apple Vision으로 대체
- 얼굴 랜드마크에 MediaPipe Face Landmarker를 쓰려 했으나, `react-native-mediapipe`(→
  `MediaPipeTasksCommon`)가 **자체 glog 심볼 ~13,000개를 `-force_load`로 정적 링크**한다.
  RN의 glog와 충돌(ODR)해 앱이 크래시한다. **어느 SDK에서도 동일.** 제거함.
- 대신 **Apple `Vision` 프레임워크 기반 커스텀 VisionCamera 프레임프로세서 플러그인**을 사용
  (`plugins/native/FaceVisionPlugin.swift`, JS 이름 `detectFace`). glog 없음, iOS 네이티브.

### 3. 빌드 패치 — `plugins/withBuildFixes.js` (prebuild 때 자동 적용)
- **fmt consteval 패치**: Xcode 26+ clang이 fmt 11의 `FMT_STRING` consteval을 거부 →
  Podfile `post_install`에서 `fmt/base.h`를 `FMT_USE_CONSTEVAL=0`으로 패치.
- **Vision 네이티브 파일 주입**: `plugins/native/*.{swift,m}`을 ios/ 앱 타깃에 복사·등록.

### 4. 기타 핀
- `react-native-vision-camera` **v4** 고정(v5는 prebuild 깨짐).
- `react-native-fast-tflite` **1.6.1**(3.x는 nitro-modules 필요 → RN 0.76 부적합). MoveNet
  레거시 경로용이며 Apple Vision 전환과 함께 단계적으로 제거 예정.

---

## 실행

**실기기(iPhone) 필수.** 시뮬레이터는 카메라가 없어 얼굴 검출이 안 된다(빌드 검증만 가능).
Expo Go 불가(네이티브 모듈) → dev client 빌드 필요.

```bash
npm install --legacy-peer-deps
npx expo prebuild -p ios          # withBuildFixes가 fmt 패치 + Vision 플러그인 주입
npx expo run:ios --device         # 실기기 빌드·설치 (Debug + Metro)
```

> 첫 빌드는 React를 소스에서 컴파일하므로 오래 걸린다(10~30분). 이후는 증분.
> 시뮬레이터 빌드 검증: `xcodebuild ... -sdk iphonesimulator EXCLUDED_ARCHS=x86_64`
> (Apple Silicon은 arm64 시뮬만; x86_64 슬라이스는 별도 RN 링크 이슈가 있음).

크래시 디버깅: 시뮬레이터 크래시 리포트는 `~/Library/Logs/DiagnosticReports/app-*.ips`.

---

## 구조

```
src/
  face/                        # Apple Vision 얼굴 매칭 (신규)
    types.ts                   #   FaceFeatures + front/back 좌우 보정
    FaceVisionSpikeScreen.tsx  #   detectFace 검증용 스파이크 (각도/표정/fps HUD)
  pose/                        # MoveNet 레거시 (단계적 제거 예정)
  screens/                     # Home / ReferencePick / Shoot / Compare
  components/, store/
plugins/
  withBuildFixes.js            # config plugin: fmt 패치 + Vision 네이티브 주입
  native/
    FaceVisionPlugin.swift     # VNDetectFaceLandmarksRequest → 구도/각도/표정/시선
    FaceVisionPlugin.m         # "detectFace" 프레임프로세서 등록
```

### Apple Vision → 4항목 매핑
- **구도**: `VNFaceObservation.boundingBox` (중심 x/y + 크기)
- **각도**: `VNFaceObservation.yaw / pitch / roll` (네이티브, radian)
- **표정**: blendshape 없음 → 랜드마크 기하 근사 (입벌림·미소·눈 감음)
- **시선**: 동공(`leftPupil`/`rightPupil`)의 눈 영역 내 상대 위치로 방향 근사

> 표정/시선은 MediaPipe blendshape보다 거칠다(기하 근사). UI 문구도 "방향 수준"으로
> ("정면을 봐주세요" O / "이 점을 정확히 응시" X).

---

## 상태 / 다음 단계

- [x] SDK 52 베이스 동작 (앱 부팅·렌더)
- [x] Apple Vision `detectFace` 네이티브 플러그인 통합 (등록·초기화 검증)
- [ ] 실기기에서 detectFace 값/fps 확인 (← 지금 여기)
- [ ] `matchFace.ts` — 4분할 일치율 (실측 범위로 정규화)
- [ ] `guide.ts` — 가장 어긋난 항목 한국어 코칭
- [ ] ReferencePick/Shoot 화면을 detectFace로 교체 + 자동셔터(4항목 AND)
