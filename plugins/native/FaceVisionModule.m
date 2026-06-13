//
//  FaceVisionModule.m
//  정지 이미지 얼굴 검출 네이티브 모듈 등록
//
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(FaceVisionModule, NSObject)

RCT_EXTERN_METHOD(detectOnImage:(NSString *)uri
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
