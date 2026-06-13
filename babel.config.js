module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // 순서 중요: worklets-core 먼저, reanimated가 마지막
      'react-native-worklets-core/plugin',
      'react-native-reanimated/plugin',
    ],
  };
};
