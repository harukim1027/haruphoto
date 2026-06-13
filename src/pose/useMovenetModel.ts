import { useEffect, useState } from 'react';
import { Asset } from 'expo-asset';
import {
  loadTensorflowModel,
  type TensorflowModel,
} from 'react-native-fast-tflite';

// require()는 모듈 평가 시 한 번만 실행되어 메트로에 에셋을 등록한다.
// (컴포넌트 렌더마다 새 모듈을 만들지 않도록 최상단에 둔다.)
const MODEL_MODULE = require('../../assets/movenet_lightning.tflite');

/**
 * useTensorflowModel(require(...)) 와 동일한 형태의 상태를 반환한다.
 * 화면 코드를 그대로 두기 위해 fast-tflite 의 TensorflowPlugin 유니온을 그대로 흉내낸다.
 */
export type MovenetModel =
  | { model: TensorflowModel; state: 'loaded' }
  | { model: undefined; state: 'loading' }
  | { model: undefined; error: Error; state: 'error' };

/**
 * MoveNet(.tflite) 모델 로딩 훅.
 *
 * fast-tflite 에 require() 를 직접 넘기면 dev 모드에서는 모델이 메트로 HTTP URL 로
 * 들어와 네이티브 쪽에서 파일을 읽지 못해 "Failed to load Tensorflow Model" 이 난다.
 * 그래서 expo-asset 으로 모델을 로컬 파일(file://)로 먼저 확보한 뒤,
 * loadTensorflowModel({ url }) 에 그 경로를 넘긴다.
 *
 * - dev(메트로 연결): downloadAsync() 가 메트로 URL → 로컬 캐시로 받아 localUri 확보
 * - release(번들 포함): 에셋이 이미 앱 번들에 있으므로 즉시 localUri 확보
 * 두 경우 모두 동일한 file:// 경로 방식으로 로드된다.
 */
export function useMovenetModel(): MovenetModel {
  const [result, setResult] = useState<MovenetModel>({
    model: undefined,
    state: 'loading',
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const asset = Asset.fromModule(MODEL_MODULE);
        if (!asset.localUri) {
          await asset.downloadAsync();
        }
        const localUri = asset.localUri ?? asset.uri;
        if (!localUri) {
          throw new Error('모델 에셋의 로컬 경로를 확보하지 못했습니다.');
        }

        // delegates: [] = 표준 CPU delegate(기본값). GPU 가속이 필요하면
        // ['core-ml'](iOS)/['android-gpu'] 등을 넣을 수 있으나 MoveNet int8 에선 불필요.
        const model = await loadTensorflowModel({ url: localUri }, []);
        if (!cancelled) {
          setResult({ model, state: 'loaded' });
        }
      } catch (e) {
        console.error('MoveNet 모델 로드 실패', e);
        if (!cancelled) {
          setResult({
            model: undefined,
            error: e instanceof Error ? e : new Error(String(e)),
            state: 'error',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return result;
}
