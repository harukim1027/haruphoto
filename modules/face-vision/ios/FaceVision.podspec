Pod::Spec.new do |s|
  s.name           = 'FaceVision'
  s.version        = '1.0.0'
  s.summary        = 'Apple Vision 정지이미지 얼굴 검출 (Expo 로컬 모듈)'
  s.description     = 'VNDetectFaceLandmarksRequest 기반 still-image 얼굴 특징 추출'
  s.author         = ''
  s.homepage       = 'https://github.com/harukim1027/haruphoto'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
