/**
 * Expo config plugin — 네이티브 빌드 수정 + Apple Vision 프레임프로세서 플러그인 주입.
 * prebuild 에서 매번 적용되므로 `expo prebuild --clean` 후에도 유지된다.
 *
 *  1) fmt(11.x) consteval 이 Xcode 26+ clang 에서 깨지는 문제 → Podfile post_install
 *     에서 fmt/base.h 를 패치(FMT_USE_CONSTEVAL=0).
 *  2) plugins/native/FaceVisionPlugin.{swift,m} 을 ios/app/ 로 복사하고 앱 타깃
 *     소스에 추가 → "detectFace" VisionCamera 프레임프로세서 플러그인 등록.
 *
 *  (Expo SDK 52 는 React 를 소스 빌드하므로 prebuilt-React glog ABI 크래시는 없다.)
 */
const { withDangerousMod, withXcodeProject, IOSConfig } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# HARU_BUILD_FIXES';
const NATIVE_FILES = ['FaceVisionPlugin.swift', 'FaceVisionPlugin.m'];

const FMT_PATCH_RUBY = `
    ${MARKER}: Xcode 26+ clang rejects fmt 11 consteval format strings.
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

// 1) Podfile post_install 에 fmt 패치 주입
const withFmtFix = (config) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let podfile = fs.readFileSync(podfilePath, 'utf8');
      if (!podfile.includes(MARKER)) {
        podfile = podfile.replace(
          /(post_install do \|installer\|\n)/,
          `$1${FMT_PATCH_RUBY}\n`,
        );
        fs.writeFileSync(podfilePath, podfile);
      }
      return cfg;
    },
  ]);

// 2a) 네이티브 파일을 ios/app/ 로 복사
const withCopyNative = (config) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { projectRoot, platformProjectRoot, projectName } = cfg.modRequest;
      const srcDir = path.join(projectRoot, 'plugins', 'native');
      const destDir = path.join(platformProjectRoot, projectName);
      for (const f of NATIVE_FILES) {
        fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
      }
      return cfg;
    },
  ]);

// 2b) 복사한 소스를 앱 타깃 Sources 빌드 페이즈에 추가
const withNativeSources = (config) =>
  withXcodeProject(config, (cfg) => {
    const { projectName } = cfg.modRequest;
    const project = cfg.modResults;
    for (const f of NATIVE_FILES) {
      const filepath = `${projectName}/${f}`;
      if (!project.hasFile(filepath)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath,
          groupName: projectName,
          project,
        });
      }
    }
    return cfg;
  });

module.exports = function withBuildFixes(config) {
  config = withFmtFix(config);
  config = withCopyNative(config);
  config = withNativeSources(config);
  return config;
};
