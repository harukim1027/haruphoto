/**
 * Expo config plugin — 이 프로젝트의 네이티브 빌드 수정들을 prebuild 에서도 유지한다.
 *
 * 현재 수정: fmt(11.x)의 consteval 포맷 문자열이 Xcode 26+ clang 에서
 * "not a constant expression" 으로 거부되는 문제. fmt/base.h 가 FMT_USE_CONSTEVAL 을
 * ifndef 가드 없이 #define 하므로 외부 -D 로 못 끈다 → Podfile post_install 에서
 * 헤더를 직접 패치하도록 주입한다.
 *
 * (Expo SDK 52 는 React 를 소스에서 빌드하므로 prebuilt-React glog ABI 크래시는 없다.
 *  그래서 buildReactNativeFromSource 플래그는 불필요하다.)
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# HARU_BUILD_FIXES';

const FMT_PATCH_RUBY = `
    ${MARKER}: Xcode 26+ clang rejects fmt 11 consteval format strings.
    # fmt/base.h hard-#defines FMT_USE_CONSTEVAL (no ifndef guard), so patch it.
    fmt_base = File.join(installer.sandbox.root.to_s, 'fmt/include/fmt/base.h')
    if File.exist?(fmt_base)
      txt = File.read(fmt_base)
      unless txt.include?('HARU_FMT_PATCH')
        txt = txt.sub(
          "#if FMT_USE_CONSTEVAL\\n#  define FMT_CONSTEVAL consteval",
          "// HARU_FMT_PATCH\\n#undef FMT_USE_CONSTEVAL\\n#define FMT_USE_CONSTEVAL 0\\n#if FMT_USE_CONSTEVAL\\n#  define FMT_CONSTEVAL consteval"
        )
        File.chmod(0644, fmt_base)
        File.write(fmt_base, txt)
      end
    end
`;

const withFmtFix = (config) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(
        cfg.modRequest.platformProjectRoot,
        'Podfile',
      );
      let podfile = fs.readFileSync(podfilePath, 'utf8');
      if (!podfile.includes(MARKER)) {
        // post_install do |installer| 블록 시작 직후에 주입
        podfile = podfile.replace(
          /(post_install do \|installer\|\n)/,
          `$1${FMT_PATCH_RUBY}\n`,
        );
        fs.writeFileSync(podfilePath, podfile);
      }
      return cfg;
    },
  ]);

module.exports = function withBuildFixes(config) {
  return withFmtFix(config);
};
