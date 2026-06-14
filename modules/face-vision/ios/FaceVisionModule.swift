//
//  FaceVisionModule.swift  (Expo Module)
//  정지 이미지(레퍼런스 사진) 얼굴 검출 — Apple Vision.
//  bridgeless/New Arch 에서 NativeModules 가 안 잡혀서 Expo Modules API 로 작성.
//  JS: requireNativeModule('FaceVision').detectOnImage(uri) -> FaceVisionResult
//
import ExpoModulesCore
import Vision
import UIKit
import CoreVideo

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
      let poseReq = VNDetectHumanBodyPoseRequest()
      var reqs: [VNRequest] = [faceReq, poseReq]
      var segReq: VNGeneratePersonSegmentationRequest?
      if #available(iOS 15.0, *) {
        let s = VNGeneratePersonSegmentationRequest()
        s.qualityLevel = .accurate // 정지(1회) → 디테일 최대(고해상 마스크)
        s.outputPixelFormat = kCVPixelFormatType_OneComponent8
        segReq = s
        reqs.append(s)
      }
      let handler = VNImageRequestHandler(
        cgImage: cg,
        orientation: Self.cgOrientation(image.imageOrientation),
        options: [:]
      )
      do {
        try handler.perform(reqs)
      } catch {
        return ["found": false, "err": "vision_failed: \(error.localizedDescription)"]
      }
      // EXIF 적용 후 upright(표시) 크기
      let o = image.imageOrientation
      let isSide = (o == .left || o == .right || o == .leftMirrored || o == .rightMirrored)
      let upW = isSide ? cg.height : cg.width
      let upH = isSide ? cg.width : cg.height
      let pose = Self.poseJoints(poseReq.results?.first)
      var bodyOutline: [[Double]]?
      if #available(iOS 15.0, *),
         let seg = segReq?.results?.first as? VNPixelBufferObservation {
        bodyOutline = Self.bodySilhouette(seg.pixelBuffer, eps: 0.003) // 레퍼런스: 디테일 최대
      }
      // 공통: pose / bodyOutline 주입
      func finalize(_ base: [String: Any]) -> [String: Any] {
        var r = base
        if let pose = pose { r["pose"] = pose }
        if let b = bodyOutline { r["bodyOutline"] = b }
        return r
      }
      guard let face = faceReq.results?.first else {
        // 얼굴이 없어도 상체 포즈/실루엣이 있으면 반신으로 인정
        if pose != nil || bodyOutline != nil {
          return finalize(["found": true, "faceOnly": false, "noFace": true,
                           "imgW": Double(upW), "imgH": Double(upH)])
        }
        return ["found": false, "err": "no_face", "imgW": Double(upW), "imgH": Double(upH)]
      }
      return finalize(Self.features(from: face, imgW: upW, imgH: upH))
    }
  }

  /// 인물 분할 마스크 → 실제 경계 contour(Moore 추적) → DP 단순화.
  /// 행-스캔 envelope 대신 진짜 외곽을 따라가 목-어깨-팔 굴곡까지 표현.
  static func bodySilhouette(_ mask: CVPixelBuffer, eps: Double = 0.003) -> [[Double]]? {
    CVPixelBufferLockBaseAddress(mask, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
    let w = CVPixelBufferGetWidth(mask)
    let h = CVPixelBufferGetHeight(mask)
    guard w > 4, h > 4, let base = CVPixelBufferGetBaseAddress(mask) else { return nil }
    let bpr = CVPixelBufferGetBytesPerRow(mask)
    let ptr = base.assumingMemoryBound(to: UInt8.self)
    let thr: UInt8 = 128
    func fg(_ x: Int, _ y: Int) -> Bool {
      x >= 0 && x < w && y >= 0 && y < h && ptr[y * bpr + x] >= thr
    }
    var start: (Int, Int)?
    outer: for y in 0..<h { for x in 0..<w where fg(x, y) { start = (x, y); break outer } }
    guard let s = start else { return nil }
    let nb = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
    var contour: [[Double]] = [[Double(s.0) / Double(w - 1), Double(s.1) / Double(h - 1)]]
    var cur = s
    var backIdx = 4
    let maxSteps = (w + h) * 8
    var steps = 0
    repeat {
      var found = false
      for k in 1...8 {
        let i = (backIdx + k) % 8
        let nx = cur.0 + nb[i].0, ny = cur.1 + nb[i].1
        if fg(nx, ny) {
          backIdx = (i + 4) % 8
          cur = (nx, ny)
          contour.append([Double(nx) / Double(w - 1), Double(ny) / Double(h - 1)])
          found = true
          break
        }
      }
      if !found { break }
      steps += 1
    } while !(cur == s) && steps < maxSteps
    if contour.count < 8 { return nil }
    return Self.douglasPeucker(contour, eps: eps)
  }

  /// Douglas-Peucker 단순화(점 수 줄이되 굴곡 보존).
  static func douglasPeucker(_ pts: [[Double]], eps: Double) -> [[Double]] {
    if pts.count < 3 { return pts }
    func segDist2(_ p: [Double], _ a: [Double], _ b: [Double]) -> Double {
      let dx = b[0] - a[0], dy = b[1] - a[1]
      let l = dx * dx + dy * dy
      if l < 1e-12 { return (p[0]-a[0])*(p[0]-a[0]) + (p[1]-a[1])*(p[1]-a[1]) }
      var t = ((p[0]-a[0]) * dx + (p[1]-a[1]) * dy) / l
      t = max(0, min(1, t))
      let px = a[0] + t * dx, py = a[1] + t * dy
      return (p[0]-px)*(p[0]-px) + (p[1]-py)*(p[1]-py)
    }
    var keep = [Bool](repeating: false, count: pts.count)
    keep[0] = true; keep[pts.count - 1] = true
    var stack: [(Int, Int)] = [(0, pts.count - 1)]
    let e2 = eps * eps
    while let (s, e) = stack.popLast() {
      if e <= s + 1 { continue }
      var maxD = 0.0, idx = -1
      for i in (s + 1)..<e {
        let d = segDist2(pts[i], pts[s], pts[e])
        if d > maxD { maxD = d; idx = i }
      }
      if maxD > e2 && idx >= 0 {
        keep[idx] = true
        stack.append((s, idx)); stack.append((idx, e))
      }
    }
    var out: [[Double]] = []
    for i in 0..<pts.count where keep[i] { out.append(pts[i]) }
    return out
  }

  /// 상체 관절(목/어깨/팔꿈치/손목/골반중심) → top-left 정규화 + 신뢰도
  static func poseJoints(_ obs: VNHumanBodyPoseObservation?) -> [String: Any]? {
    guard let body = obs else { return nil }
    let names: [(String, VNHumanBodyPoseObservation.JointName)] = [
      ("neck", .neck),
      ("leftShoulder", .leftShoulder), ("rightShoulder", .rightShoulder),
      ("leftElbow", .leftElbow), ("rightElbow", .rightElbow),
      ("leftWrist", .leftWrist), ("rightWrist", .rightWrist),
      ("root", .root),
    ]
    var out: [String: Any] = [:]
    for (key, jn) in names {
      if let p = try? body.recognizedPoint(jn), p.confidence > 0.05 {
        out[key] = ["x": Double(p.location.x), "y": Double(1.0 - p.location.y),
                    "c": Double(p.confidence)]
      }
    }
    return out.isEmpty ? nil : out
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

    // 얼굴 외곽 윤곽선 (Apple Vision faceContour, top-left 정규화 [x,y] 배열)
    if let fc = contourPoints(lm.faceContour, bb: bb) { out["faceContour"] = fc }
    return out
  }

  /// 랜드마크 region 의 모든 점 → top-left 정규화 이미지 좌표 [[x,y],...]
  static func contourPoints(_ region: VNFaceLandmarkRegion2D?, bb: CGRect) -> [[Double]]? {
    guard let pts = region?.normalizedPoints, pts.count >= 3 else { return nil }
    return pts.map { p in
      [
        Double(bb.minX) + Double(p.x) * Double(bb.width),
        1.0 - (Double(bb.minY) + Double(p.y) * Double(bb.height)),
      ]
    }
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
