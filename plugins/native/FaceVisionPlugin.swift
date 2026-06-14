//
//  FaceVisionPlugin.swift
//  VisionCamera Frame Processor Plugin — Apple Vision 얼굴 분석
//
//  JS: const r = detectFace(frame)  →
//    { found, x, y, size, yaw, pitch, roll,
//      mouthOpen, smile, leftEyeOpen, rightEyeOpen, gazeX, gazeY, mirrored }
//  모든 값은 0~1 정규화(각도는 radian). 좌표계 보정(front/back)은 JS에서 처리.
//
import Foundation
import Vision
import CoreMedia
import CoreVideo
import VisionCamera

@objc(FaceVisionPlugin)
public class FaceVisionPlugin: FrameProcessorPlugin {
  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
  }

  public override func callback(_ frame: Frame, withArguments arguments: [AnyHashable: Any]?) -> Any? {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(frame.buffer) else {
      return ["found": false]
    }

    let orientation = cgOrientation(from: frame.orientation)
    let faceReq = VNDetectFaceLandmarksRequest()
    let poseReq = VNDetectHumanBodyPoseRequest()
    var reqs: [VNRequest] = [faceReq, poseReq]
    var segReq: VNGeneratePersonSegmentationRequest?
    if #available(iOS 15.0, *) {
      let s = VNGeneratePersonSegmentationRequest()
      s.qualityLevel = .fast // 라이브 → 속도 우선
      s.outputPixelFormat = kCVPixelFormatType_OneComponent8
      segReq = s
      reqs.append(s)
    }
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    do {
      try handler.perform(reqs)
    } catch {
      return ["found": false]
    }
    let pose = Self.poseJoints(poseReq.results?.first)
    // 진단: 포즈 관찰 수 + 신뢰도 무관 인식 관절 수(왜 pose=0 인지 판별).
    let poseObs = poseReq.results?.count ?? 0
    var poseRaw = 0
    if let body = poseReq.results?.first,
       let pts = try? body.recognizedPoints(.all) {
      poseRaw = pts.values.filter { $0.confidence > 0 }.count
    }
    var bodyOutline: [[Double]]?
    if #available(iOS 15.0, *),
       let seg = segReq?.results?.first as? VNPixelBufferObservation {
      bodyOutline = Self.bodySilhouette(seg.pixelBuffer)
    }
    func finalize(_ base: [String: Any]) -> [String: Any] {
      var r = base
      r["poseObs"] = poseObs
      r["poseRaw"] = poseRaw
      if let pose = pose { r["pose"] = pose }
      if let b = bodyOutline { r["bodyOutline"] = b }
      return r
    }
    guard let face = (faceReq.results)?.first else {
      if pose != nil || bodyOutline != nil {
        return finalize(["found": true, "noFace": true, "mirrored": frame.isMirrored])
      }
      return ["found": false]
    }
    return finalize(Self.features(from: face, mirrored: frame.isMirrored))
  }

  /// 인물 분할 마스크 → 몸 실루엣 외곽 폴리곤 (top-left 정규화, 닫힌 형태).
  static func bodySilhouette(_ mask: CVPixelBuffer) -> [[Double]]? {
    CVPixelBufferLockBaseAddress(mask, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
    let w = CVPixelBufferGetWidth(mask)
    let h = CVPixelBufferGetHeight(mask)
    guard w > 2, h > 2, let base = CVPixelBufferGetBaseAddress(mask) else { return nil }
    let bpr = CVPixelBufferGetBytesPerRow(mask)
    let ptr = base.assumingMemoryBound(to: UInt8.self)
    let thr: UInt8 = 128
    let rows = min(56, h)
    var left: [[Double]] = []
    var right: [[Double]] = []
    for i in 0..<rows {
      let y = Int(Double(i) / Double(rows - 1) * Double(h - 1))
      let rowPtr = ptr + y * bpr
      var minX = -1, maxX = -1
      var x = 0
      while x < w {
        if rowPtr[x] >= thr { if minX < 0 { minX = x }; maxX = x }
        x += 2
      }
      if minX >= 0 {
        let ny = Double(y) / Double(h - 1)
        left.append([Double(minX) / Double(w - 1), ny])
        right.append([Double(maxX) / Double(w - 1), ny])
      }
    }
    if left.count < 3 { return nil }
    var poly = left
    poly.append(contentsOf: right.reversed())
    return poly
  }

  /// 상체 관절 → top-left 정규화 + 신뢰도
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

  /// VNFaceObservation → 정규화된 특징 딕셔너리
  static func features(from face: VNFaceObservation, mirrored: Bool) -> [String: Any] {
    var out: [String: Any] = ["found": true, "mirrored": mirrored]

    // ── 구도: boundingBox(정규화, 원점 좌하단) → 중심/크기 ──
    let bb = face.boundingBox
    out["x"] = Double(bb.midX)
    out["y"] = Double(1.0 - bb.midY) // 상단 기준으로 뒤집음
    out["size"] = Double(max(bb.width, bb.height))

    // ── 각도: yaw/roll(iOS12+), pitch(iOS15+), radian ──
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

    // ── 표정 근사 ──
    // 입 벌림: 안쪽 입술의 세로 범위 / 가로 범위
    out["mouthOpen"] = aspect(lm.innerLips, vertical: true)
    // 미소: 입꼬리(가장 좌/우 점)가 입 중심보다 위로 올라간 정도
    out["smile"] = smileScore(lm.outerLips)
    // 눈 감음/뜸: 눈 세로/가로 비 (EAR 유사)
    out["leftEyeOpen"] = aspect(lm.leftEye, vertical: true)
    out["rightEyeOpen"] = aspect(lm.rightEye, vertical: true)

    // ── 시선 근사: 동공이 눈 영역 안에서 어디에 있는지 ──
    let g = gaze(pupil: lm.leftPupil, eye: lm.leftEye)
    let g2 = gaze(pupil: lm.rightPupil, eye: lm.rightEye)
    out["gazeX"] = (g.x + g2.x) / 2.0
    out["gazeY"] = (g.y + g2.y) / 2.0

    // ── 얼굴 외곽 윤곽선 (faceContour, top-left 정규화 [x,y] 배열) ──
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

  // MARK: - 기하 헬퍼 (landmark 점들은 boundingBox 기준 0~1)

  private static func aspect(_ region: VNFaceLandmarkRegion2D?, vertical: Bool) -> Double {
    guard let pts = region?.normalizedPoints, pts.count >= 2 else { return 0 }
    let xs = pts.map { Double($0.x) }, ys = pts.map { Double($0.y) }
    let w = (xs.max()! - xs.min()!), h = (ys.max()! - ys.min()!)
    guard w > 1e-4 else { return 0 }
    return min(max(h / w, 0), 1) // 세로/가로 비
  }

  private static func smileScore(_ region: VNFaceLandmarkRegion2D?) -> Double {
    guard let pts = region?.normalizedPoints, pts.count >= 4 else { return 0 }
    let xs = pts.map { Double($0.x) }, ys = pts.map { Double($0.y) }
    // 좌/우 끝점(입꼬리)의 평균 y vs 전체 입의 중앙 y. 입꼬리가 위면 미소.
    let minX = xs.min()!, maxX = xs.max()!
    let leftY = ys[xs.firstIndex(of: minX)!]
    let rightY = ys[xs.firstIndex(of: maxX)!]
    let cornerY = (leftY + rightY) / 2.0
    let centerY = ys.reduce(0, +) / Double(ys.count)
    // Vision y는 위로 갈수록 큼 → 입꼬리가 중심보다 높으면 양수
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
    let gx = (Double(p.x) - minX) / w   // 0(좌)~1(우)
    let gy = (Double(p.y) - minY) / h   // 0(하)~1(상)
    return (min(max(gx, 0), 1), min(max(gy, 0), 1))
  }

  /// VisionCamera Frame.orientation(UIImageOrientation) → Vision CGImagePropertyOrientation
  private func cgOrientation(from o: UIImage.Orientation) -> CGImagePropertyOrientation {
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
