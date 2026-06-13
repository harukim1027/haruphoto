const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// .tflite 모델 파일을 에셋으로 번들링
config.resolver.assetExts.push('tflite');

module.exports = config;
