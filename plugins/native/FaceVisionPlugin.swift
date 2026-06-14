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
    // Face + Segmentation (방향에 둔감 — 현재 orientation 으로 동작 확인됨)
    let faceReq = VNDetectFaceLandmarksRequest()
    var reqs: [VNRequest] = [faceReq]
    var segReq: VNGeneratePersonSegmentationRequest?
    if #available(iOS 15.0, *) {
      let s = VNGeneratePersonSegmentationRequest()
      s.qualityLevel = .balanced // 디테일 향상(뭉뚱그림 완화). fps 낮으면 .fast 로.
      s.outputPixelFormat = kCVPixelFormatType_OneComponent8
      segReq = s
      reqs.append(s)
    }
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    try? handler.perform(reqs)

    // Pose: 방향 민감 → 별도 핸들러. 캐시된 방향 우선, 0이면 1초마다 8방향 스윕(자동보정).
    let (pose, poseObs, poseRaw, poseOri) = Self.detectPose(pixelBuffer, primary: orientation)

    var bodyOutline: [[Double]]?
    if #available(iOS 15.0, *),
       let seg = segReq?.results?.first as? VNPixelBufferObservation {
      bodyOutline = Self.bodySilhouette(seg.pixelBuffer, eps: 0.006) // 라이브: 디테일/성능 균형
    }
    func finalize(_ base: [String: Any]) -> [String: Any] {
      var r = base
      r["poseObs"] = poseObs
      r["poseRaw"] = poseRaw
      r["poseOri"] = poseOri
      r["frameOri"] = Int(frame.orientation.rawValue) // 진단: 프레임 방향 확정
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

  // 포즈 검출 방향: 캘리브레이션 투표 → 하드 락. 락 후 재스윕 안 함(좌표계 안정).
  static var poseLockedOri: CGImagePropertyOrientation? // 확정된 방향(락)
  static var poseVotes: [Int: Int] = [:]                // 캘리브레이션 투표(ori.rawValue→표수)
  static var poseMissStreak: Int = 0                    // 연속 미검출(락 해제 판단)
  static var poseLastSweep: Double = 0                  // 스윕 throttle

  /// 상체 포즈 검출.
  /// - 락된 방향이 있으면 그 방향만 사용(좌표계 고정). 한두 프레임 놓쳐도 즉시 락 해제 안 함
  ///   (JS가 last-good pose 를 hold). 지속 손실(streak)일 때만 재캘리브레이션.
  /// - 미락 상태: 0.25초마다 8방향 스윕 → "직립도(어깨>골반, 목>어깨) 우선, 그다음 관절수"로
  ///   최적 방향 선택 → 투표 누적 → 충분히 모이면 최빈 방향을 하드 락.
  ///   (관절수만 보면 회전된 방향도 비슷해 thrash → 직립도가 진짜 방향을 가른다.)
  /// 반환: (관절, 관찰수, raw관절수, 사용방향명)
  static func detectPose(_ pb: CVPixelBuffer, primary: CGImagePropertyOrientation)
    -> ([String: Any]?, Int, Int, String) {
    func run(_ ori: CGImagePropertyOrientation) -> VNHumanBodyPoseObservation? {
      let req = VNDetectHumanBodyPoseRequest()
      let h = VNImageRequestHandler(cvPixelBuffer: pb, orientation: ori, options: [:])
      try? h.perform([req])
      return req.results?.first
    }
    func rawCount(_ o: VNHumanBodyPoseObservation) -> Int {
      (try? o.recognizedPoints(.all))?.values.filter { $0.confidence > 0 }.count ?? 0
    }
    // Vision 좌표(원점 좌하단, y 위로 증가). 직립이면 어깨 y > 골반 y, 목 y > 어깨 y.
    func jointY(_ o: VNHumanBodyPoseObservation, _ jn: VNHumanBodyPoseObservation.JointName) -> Double? {
      if let p = try? o.recognizedPoint(jn), p.confidence > 0.1 { return Double(p.location.y) }
      return nil
    }
    func uprightOK(_ o: VNHumanBodyPoseObservation) -> Bool {
      let lS = jointY(o, .leftShoulder), rS = jointY(o, .rightShoulder)
      let shMid: Double? = (lS != nil && rS != nil) ? (lS! + rS!) / 2 : (lS ?? rS)
      if let sh = shMid, let rt = jointY(o, .root) { return sh > rt }       // 어깨가 골반 위
      if let nk = jointY(o, .neck), let sh = shMid { return nk >= sh - 0.03 } // 목이 어깨 위/근처
      return false // 토르소 단서 없으면 직립 보너스 없음(관절수로만 경쟁)
    }
    // 점수: 직립이면 +100(회전 방향 배제), 그 위에 관절수.
    func quality(_ o: VNHumanBodyPoseObservation) -> Int {
      rawCount(o) + (uprightOK(o) ? 100 : 0)
    }

    // 1) 락된 방향 우선 — 좌표계 고정. 놓쳐도 잠깐은 nil(JS hold)로 메움.
    if let lock = poseLockedOri {
      if let o = run(lock), rawCount(o) >= 4 {
        poseMissStreak = 0
        return (poseJoints(o), 1, rawCount(o), oriName(lock))
      }
      poseMissStreak += 1
      if poseMissStreak < 20 { return (nil, 0, 0, "lock?") } // 지속 손실 전엔 락 유지
      // 지속 손실 → 락 해제 후 재캘리브레이션
      poseLockedOri = nil; poseVotes = [:]; poseMissStreak = 0
    }

    // 2) 미락(캘리브레이션): throttle 두고 스윕 → 직립도 우선 최적 방향 선택.
    let now = Date().timeIntervalSince1970
    if now - poseLastSweep < 0.25 { return (nil, 0, 0, "calib") }
    poseLastSweep = now
    let all: [CGImagePropertyOrientation] = [
      .up, .right, .left, .down, .upMirrored, .rightMirrored, .leftMirrored, .downMirrored,
    ]
    var best: VNHumanBodyPoseObservation?
    var bestOri = primary
    var bestQ = -1
    for ori in all {
      if let o = run(ori) {
        let q = quality(o)
        if q > bestQ { bestQ = q; best = o; bestOri = ori }
      }
    }
    guard let body = best, rawCount(body) >= 6 else { return (nil, 0, 0, "none") }
    // 투표 누적 → 4표 이상이면 최빈 방향 하드 락.
    poseVotes[Int(bestOri.rawValue), default: 0] += 1
    let total = poseVotes.values.reduce(0, +)
    if total >= 4, let top = poseVotes.max(by: { $0.value < $1.value })?.key,
       let ori = CGImagePropertyOrientation(rawValue: UInt32(top)) {
      poseLockedOri = ori
    }
    return (poseJoints(body), 1, rawCount(body), oriName(bestOri))
  }

  static func oriName(_ o: CGImagePropertyOrientation) -> String {
    switch o {
    case .up: return "up"; case .down: return "down"
    case .left: return "left"; case .right: return "right"
    case .upMirrored: return "upM"; case .downMirrored: return "downM"
    case .leftMirrored: return "leftM"; case .rightMirrored: return "rightM"
    @unknown default: return "?"
    }
  }

  /// 인물 분할 마스크 → 실제 경계 contour(Moore 추적) → DP 단순화.
  /// 행-스캔 envelope 대신 진짜 외곽을 따라가 목-어깨-팔 굴곡까지 표현.
  /// eps: 단순화 강도(정규화 좌표). 작을수록 디테일↑.
  static func bodySilhouette(_ mask: CVPixelBuffer, eps: Double = 0.005) -> [[Double]]? {
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
    // 시계방향 8이웃 (E,SE,S,SW,W,NW,N,NE)
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
