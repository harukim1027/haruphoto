//
//  FaceVisionModule.swift  (Expo Module)
//  정지 이미지(레퍼런스 사진) 얼굴 검출 — Apple Vision.
//  bridgeless/New Arch 에서 NativeModules 가 안 잡혀서 Expo Modules API 로 작성.
//  JS: requireNativeModule('FaceVision').detectOnImage(uri) -> FaceVisionResult
//
import ExpoModulesCore
import Vision
import UIKit

public class FaceVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FaceVision")

    AsyncFunction("detectOnImage") { (uri: String) -> [String: Any] in
      let path = uri.hasPrefix("file://") ? String(uri.dropFirst("file://".count)) : uri
      guard let image = UIImage(contentsOfFile: path) else {
        return ["found": false, "err": "image_load_failed"]
      }
      guard let cg = image.cgImage else {
        return ["found": false, "err": "no_cgimage"]
      }
      let faceReq = VNDetectFaceLandmarksRequest()
      let bodyReq = VNDetectHumanRectanglesRequest()
      if #available(iOS 15.0, *) { bodyReq.upperBodyOnly = true }
      let handler = VNImageRequestHandler(
        cgImage: cg,
        orientation: Self.cgOrientation(image.imageOrientation),
        options: [:]
      )
      do {
        try handler.perform([faceReq, bodyReq])
      } catch {
        return ["found": false, "err": "vision_failed: \(error.localizedDescription)"]
      }
      // EXIF 적용 후 upright(표시) 크기
      let o = image.imageOrientation
      let isSide = (o == .left || o == .right || o == .leftMirrored || o == .rightMirrored)
      let upW = isSide ? cg.height : cg.width
      let upH = isSide ? cg.width : cg.height
      guard let face = faceReq.results?.first else {
        return ["found": false, "err": "no_face", "imgW": Double(upW), "imgH": Double(upH)]
      }
      var result = Self.features(from: face, imgW: upW, imgH: upH)
      if let body = Self.bodyBox(bodyReq.results?.first) { result["body"] = body }
      return result
    }
  }

  /// 상체 박스 → top-left 정규화 dict
  static func bodyBox(_ obs: VNHumanObservation?) -> [String: Double]? {
    guard let b = obs, b.confidence > 0.3 else { return nil }
    let bb = b.boundingBox
    return ["x": Double(bb.minX), "y": Double(1.0 - bb.maxY),
            "w": Double(bb.width), "h": Double(bb.height)]
  }

  // MARK: - Vision 추출 (FaceVisionPlugin 과 동일 로직, 정지이미지용)

  static func features(from face: VNFaceObservation, imgW: Int, imgH: Int) -> [String: Any] {
    var out: [String: Any] = ["found": true, "mirrored": false]
    out["imgW"] = Double(imgW)
    out["imgH"] = Double(imgH)

    let bb = face.boundingBox
    out["x"] = Double(bb.midX)
    out["y"] = Double(1.0 - bb.midY)
    out["size"] = Double(max(bb.width, bb.height))
    // bbox (top-left 정규화) — cover 매핑으로 화면에 그리기 위함
    out["bx"] = Double(bb.minX)
    out["by"] = Double(1.0 - bb.maxY)
    out["bw"] = Double(bb.width)
    out["bh"] = Double(bb.height)

    out["yaw"] = face.yaw?.doubleValue ?? 0
    out["roll"] = face.roll?.doubleValue ?? 0
    if #available(iOS 15.0, *) {
      out["pitch"] = face.pitch?.doubleValue ?? 0
    } else {
      out["pitch"] = 0
    }

    guard let lm = face.landmarks else {
      out["mouthOpen"] = 0; out["smile"] = 0
      out["leftEyeOpen"] = 0; out["rightEyeOpen"] = 0
      out["gazeX"] = 0; out["gazeY"] = 0
      return out
    }

    out["mouthOpen"] = aspect(lm.innerLips)
    out["smile"] = smileScore(lm.outerLips)
    out["leftEyeOpen"] = aspect(lm.leftEye)
    out["rightEyeOpen"] = aspect(lm.rightEye)

    let g = gaze(pupil: lm.leftPupil, eye: lm.leftEye)
    let g2 = gaze(pupil: lm.rightPupil, eye: lm.rightEye)
    out["gazeX"] = (g.x + g2.x) / 2.0
    out["gazeY"] = (g.y + g2.y) / 2.0

    // 검증/오버레이용 랜드마크 점 (top-left 정규화 이미지 좌표)
    var points: [String: Any] = [:]
    if let p = centroidTopLeft(lm.leftEye, bb: bb) { points["leftEye"] = p }
    if let p = centroidTopLeft(lm.rightEye, bb: bb) { points["rightEye"] = p }
    if let p = centroidTopLeft(lm.nose, bb: bb) { points["nose"] = p }
    if let p = centroidTopLeft(lm.outerLips, bb: bb) { points["mouth"] = p }
    out["points"] = points
    return out
  }

  /// 랜드마크 region 중심 → top-left 정규화 이미지 좌표 (Mac 검증된 매핑)
  private static func centroidTopLeft(_ region: VNFaceLandmarkRegion2D?, bb: CGRect) -> [String: Double]? {
    guard let pts = region?.normalizedPoints, !pts.isEmpty else { return nil }
    let cx = pts.map { Double($0.x) }.reduce(0, +) / Double(pts.count)
    let cy = pts.map { Double($0.y) }.reduce(0, +) / Double(pts.count)
    let ix = Double(bb.minX) + cx * Double(bb.width)
    let iyBottom = Double(bb.minY) + cy * Double(bb.height)
    return ["x": ix, "y": 1.0 - iyBottom]
  }

  private static func aspect(_ region: VNFaceLandmarkRegion2D?) -> Double {
    guard let pts = region?.normalizedPoints, pts.count >= 2 else { return 0 }
    let xs = pts.map { Double($0.x) }, ys = pts.map { Double($0.y) }
    let w = (xs.max()! - xs.min()!), h = (ys.max()! - ys.min()!)
    guard w > 1e-4 else { return 0 }
    return min(max(h / w, 0), 1)
  }

  private static func smileScore(_ region: VNFaceLandmarkRegion2D?) -> Double {
    guard let pts = region?.normalizedPoints, pts.count >= 4 else { return 0 }
    let xs = pts.map { Double($0.x) }, ys = pts.map { Double($0.y) }
    let minX = xs.min()!, maxX = xs.max()!
    let leftY = ys[xs.firstIndex(of: minX)!]
    let rightY = ys[xs.firstIndex(of: maxX)!]
    let cornerY = (leftY + rightY) / 2.0
    let centerY = ys.reduce(0, +) / Double(ys.count)
    let mouthH = (ys.max()! - ys.min()!)
    guard mouthH > 1e-4 else { return 0 }
    return min(max((cornerY - centerY) / mouthH + 0.5, 0), 1)
  }

  private static func gaze(pupil: VNFaceLandmarkRegion2D?, eye: VNFaceLandmarkRegion2D?) -> (x: Double, y: Double) {
    guard let p = pupil?.normalizedPoints.first,
          let eyePts = eye?.normalizedPoints, eyePts.count >= 2 else { return (0.5, 0.5) }
    let xs = eyePts.map { Double($0.x) }, ys = eyePts.map { Double($0.y) }
    let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
    let w = max(maxX - minX, 1e-4), h = max(maxY - minY, 1e-4)
    let gx = (Double(p.x) - minX) / w
    let gy = (Double(p.y) - minY) / h
    return (min(max(gx, 0), 1), min(max(gy, 0), 1))
  }

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
