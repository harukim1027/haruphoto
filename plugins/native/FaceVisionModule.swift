//
//  FaceVisionModule.swift
//  정지 이미지(레퍼런스 사진) 얼굴 검출 — Apple Vision
//  JS: NativeModules.FaceVisionModule.detectOnImage(uri) -> Promise<FaceVisionResult>
//
import Foundation
import Vision
import UIKit

@objc(FaceVisionModule)
public class FaceVisionModule: NSObject {
  @objc(detectOnImage:resolve:reject:)
  public func detectOnImage(_ uri: String,
                            resolve: @escaping RCTPromiseResolveBlock,
                            reject: @escaping RCTPromiseRejectBlock) {
    let path = uri.hasPrefix("file://") ? String(uri.dropFirst("file://".count)) : uri
    guard let image = UIImage(contentsOfFile: path), let cg = image.cgImage else {
      resolve(["found": false])
      return
    }
    let request = VNDetectFaceLandmarksRequest()
    let handler = VNImageRequestHandler(
      cgImage: cg,
      orientation: Self.cgOrientation(image.imageOrientation),
      options: [:]
    )
    do {
      try handler.perform([request])
    } catch {
      resolve(["found": false])
      return
    }
    guard let face = request.results?.first else {
      resolve(["found": false])
      return
    }
    // 정지 이미지는 미러링 없음
    resolve(FaceVisionPlugin.features(from: face, mirrored: false))
  }

  @objc public static func requiresMainQueueSetup() -> Bool { false }

  private static func cgOrientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
    switch o {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    case .upMirrored: return .upMirrored
    case .downMirrored: return .downMirrored
    case .leftMirrored: return .leftMirrored
    case .rightMirrored: return .rightMirrored
    @unknown default: return .up
    }
  }
}
