//
//  FaceVisionPlugin.m
//  "detectFace" 이름으로 VisionCamera 프레임프로세서 플러그인 등록
//
#import <Foundation/Foundation.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>

// 앱 타깃(모듈명 app)의 Swift 생성 헤더 — FaceVisionPlugin 노출
#import "app-Swift.h"

VISION_EXPORT_SWIFT_FRAME_PROCESSOR(FaceVisionPlugin, detectFace)
