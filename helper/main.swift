// Session pet companion: a tiny transparent always-on-top window that shows the
// pet outside the DeepSeek Harness window.
//
// The plugin (plain Node, no Electron) writes state.json; this helper polls it
// and hands the JSON to the page loaded from Contents/Resources/pet. The page
// reports which rectangles should take clicks, and the helper toggles window
// mouse transparency from the global pointer position, so the empty stage stays
// click-through while the pet and its panel work like normal UI.

import Cocoa
import WebKit

private let windowWidth: CGFloat = 320
private let windowHeight: CGFloat = 360
private let petBox: CGFloat = 96

private let environment = ProcessInfo.processInfo.environment
private let statePath = environment["DSH_HACHIWARE_PET_STATE"] ?? ""
private let positionPath = environment["DSH_HACHIWARE_PET_POS"] ?? ""
private let logPath = environment["DSH_HACHIWARE_PET_LOG"] ?? ""
private let parentPid = Int32(environment["DSH_HACHIWARE_PET_PARENT"] ?? "") ?? 0
// The hub runs inside a plain Node child of the desktop shell, so parentPid is
// NOT an app. The shell's own pid arrives separately for "back to Harness".
private let harnessPid = Int32(environment["DSH_HACHIWARE_PET_APP_PID"] ?? "") ?? 0
private let harnessBundleId = "com.deepseek.dsh"
private let snapshotPath = environment["DSH_HACHIWARE_PET_SNAPSHOT"] ?? ""
// Skins live in the writable data dir, not in the app bundle: the page gets the
// sheet as a data URL (a file:// image from outside the bundle is unreadable),
// and a click drops a command file the plugin polls.
private let skinsPath = environment["DSH_HACHIWARE_PET_SKINS"] ?? ""
private let commandPath = environment["DSH_HACHIWARE_PET_COMMAND"] ?? ""

private func logLine(_ text: String) {
    guard !logPath.isEmpty else { return }
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(text)\n"
    let url = URL(fileURLWithPath: logPath)
    if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8) ?? Data())
        try? handle.close()
    } else {
        try? line.write(to: url, atomically: true, encoding: .utf8)
    }
}

/// Clicks must not pull focus away from whatever the user is doing.
final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class PetApp: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var panel: PetPanel!
    private var web: WKWebView!
    private var hits: [CGRect] = []
    private var lastState = ""
    private var documentReady = false
    private var pendingState = ""
    private var stateTimer: Timer?
    private var hoverTimer: Timer?
    private var parentTimer: Timer?
    private var saveWork: DispatchWorkItem?

    private var pageURL: URL {
        let resources = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        return resources.appendingPathComponent("pet").appendingPathComponent("index.html")
    }

    // MARK: - lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        logLine("launch (parent \(parentPid), app \(harnessPid))")

        let configuration = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: "pet")
        controller.addUserScript(WKUserScript(source: bridgeSource,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        configuration.userContentController = controller
        // A pet needs no web storage, and a non-persistent store keeps WebKit from
        // writing its cache under ~/Library (which a sandboxed host may forbid).
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistent()

        web = WKWebView(frame: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight),
                        configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight),
                         styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered,
                         defer: false)
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.ignoresMouseEvents = true
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.contentView = web
        panel.setFrameOrigin(startOrigin())
        panel.orderFrontRegardless()

        web.loadFileURL(pageURL, allowingReadAccessTo: pageURL.deletingLastPathComponent())
        startTimers()
        logLine("panel frame \(NSStringFromRect(panel.frame))")
    }

    func applicationWillTerminate(_ notification: Notification) {
        savePositionNow()
        logLine("terminate")
    }

    // MARK: - timers

    private func startTimers() {
        stateTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: true) { [weak self] _ in
            self?.readState()
        }
        hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
            self?.updateMouseTransparency()
        }
        parentTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkParent()
        }
    }

    private func readState() {
        guard !statePath.isEmpty, let data = FileManager.default.contents(atPath: statePath),
              let text = String(data: data, encoding: .utf8), !text.isEmpty, text != lastState
        else { return }
        lastState = text
        if documentReady, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let skin = object["skin"] as? [String: Any],
           let version = skin["version"] as? String, version != injectedSkinVersion {
            injectSkin()
        }
        let flat = text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
        if documentReady {
            inject(flat)
        } else {
            pendingState = flat
        }
    }

    private func inject(_ json: String) {
        web.evaluateJavaScript("window.__petState && window.__petState(\(json))") { [weak self] _, error in
            if let error = error {
                self?.log("state inject failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - skin

    private var injectedSkinVersion = ""

    private func injectSkin() {
        guard !skinsPath.isEmpty else { return }
        let current = (skinsPath as NSString).appendingPathComponent("current.json")
        guard let data = FileManager.default.contents(atPath: current),
              let config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let slug = config["slug"] as? String else {
            web.evaluateJavaScript("window.__petSkinClear && window.__petSkinClear()") { _, _ in }
            injectedSkinVersion = ""
            return
        }
        let sheetName = (config["spritesheet"] as? String) ?? "spritesheet.webp"
        let sheetPath = (((skinsPath as NSString).appendingPathComponent(slug)) as NSString)
            .appendingPathComponent(sheetName)
        guard let raw = FileManager.default.contents(atPath: sheetPath) else {
            logLine("skin sheet missing: \(sheetPath)")
            return
        }
        var columns = (config["columns"] as? NSNumber)?.intValue ?? 8
        var rows = (config["rows"] as? NSNumber)?.intValue ?? 9
        var cellWidth = (config["cell"] as? [String: Any]).flatMap { ($0["width"] as? NSNumber)?.intValue } ?? 192
        var cellHeight = (config["cell"] as? [String: Any]).flatMap { ($0["height"] as? NSNumber)?.intValue } ?? 208
        var effective = config
        if let size = imageSize(sheetPath) {
            let grid = skinGrid(width: size.width, height: size.height)
            if grid.columns != columns || grid.rows != rows
                || grid.cellWidth != cellWidth || grid.cellHeight != cellHeight {
                columns = grid.columns
                rows = grid.rows
                cellWidth = grid.cellWidth
                cellHeight = grid.cellHeight
                effective["columns"] = columns
                effective["rows"] = rows
                effective["cell"] = ["width": cellWidth, "height": cellHeight]
                logLine("skin grid from image: \(columns)x\(rows) cell \(cellWidth)x\(cellHeight)")
            }
        }
        var payload: [String: Any] = [
            "config": effective,
            "dataUrl": "data:image/webp;base64,\(raw.base64EncodedString())",
        ]
        if let frames = config["frames"] as? [Int] {
            payload["frames"] = frames
        } else if let measured = frameCounts(sheet: sheetPath, columns: columns, rows: rows,
                                             cellWidth: cellWidth, cellHeight: cellHeight) {
            payload["frames"] = measured
            logLine("skin frames: \(measured)")
        }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: jsonData, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.__petSkinApply && window.__petSkinApply(\(json))") { [weak self] _, error in
            if let error = error {
                logLine("skin inject failed: \(error.localizedDescription)")
            }
        }
        injectedSkinVersion = (config["installedAt"] as? String) ?? slug
        logLine("skin injected: \(slug) \(raw.count) bytes")
    }

    private func writeCommand(_ body: [String: Any]) {
        if commandPath.isEmpty {
            logLine("command dropped: DSH_HACHIWARE_PET_COMMAND is empty")
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: body) else {
            logLine("command dropped: could not encode \(body["action"] as? String ?? "?")")
            return
        }
        do {
            try data.write(to: URL(fileURLWithPath: commandPath), options: .atomic)
            logLine("command: \(body["action"] as? String ?? "?")")
        } catch {
            logLine("command write failed: \(error.localizedDescription)")
        }
    }

    private func updateMouseTransparency() {
        guard panel != nil else { return }
        let screenPoint = NSEvent.mouseLocation
        let local = panel.convertPoint(fromScreen: screenPoint)
        let point = CGPoint(x: local.x, y: windowHeight - local.y)
        let inside = hits.contains { $0.contains(point) }
        if inside == panel.ignoresMouseEvents {
            panel.ignoresMouseEvents = !inside
        }
    }

    private func checkParent() {
        guard parentPid > 0 else { return }
        if kill(parentPid, 0) != 0 {
            logLine("parent \(parentPid) is gone")
            NSApp.terminate(nil)
        }
    }

    // MARK: - position

    private func startOrigin() -> NSPoint {
        if !positionPath.isEmpty, let data = FileManager.default.contents(atPath: positionPath),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
           let x = parsed["x"], let y = parsed["y"] {
            return clamp(NSPoint(x: x, y: y))
        }
        return parkedOrigin()
    }

    private func visibleFrame() -> NSRect {
        return (panel?.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }

    private func clamp(_ point: NSPoint) -> NSPoint {
        let visible = visibleFrame()
        let minX = visible.minX - (windowWidth - petBox)
        let maxX = visible.maxX - petBox
        let minY = visible.minY - (windowHeight - petBox)
        let maxY = visible.maxY - petBox
        return NSPoint(x: min(max(point.x, minX), maxX),
                       y: min(max(point.y, minY), maxY))
    }

    private func parkedOrigin() -> NSPoint {
        let visible = visibleFrame()
        return NSPoint(x: visible.maxX - windowWidth - 16, y: visible.minY + 16)
    }

    private func move(by dx: Double, dy: Double) {
        var origin = panel.frame.origin
        origin.x += CGFloat(dx)
        origin.y -= CGFloat(dy)
        panel.setFrameOrigin(clamp(origin))
        schedulePositionSave()
    }

    private func park() {
        panel.setFrameOrigin(parkedOrigin())
        savePositionNow()
    }

    private func schedulePositionSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.savePositionNow() }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    private func savePositionNow() {
        guard !positionPath.isEmpty, let panel = panel else { return }
        let origin = panel.frame.origin
        let payload: [String: Double] = ["x": Double(origin.x), "y": Double(origin.y)]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let url = URL(fileURLWithPath: positionPath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    // MARK: - focus

    /// ppid of a pid via sysctl: climbs from the Node hub child to the Electron
    /// app that actually owns the Harness window.
    private func parentOf(_ pid: Int32) -> Int32 {
        guard pid > 0 else { return 0 }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return 0 }
        return info.kp_eproc.e_ppid
    }

    /// Every plausible "the Harness app" process, cheapest guess first: the pid
    /// handed over by the plugin, the grandparent of our Node parent, then the
    /// bundle identifier and finally the app name.
    private func harnessCandidates() -> [NSRunningApplication] {
        var found: [NSRunningApplication] = []
        if harnessPid > 0, let app = NSRunningApplication(processIdentifier: harnessPid) {
            found.append(app)
        }
        let grandParent = parentOf(parentPid)
        if grandParent > 0, let app = NSRunningApplication(processIdentifier: grandParent) {
            found.append(app)
        }
        found += NSRunningApplication.runningApplications(withBundleIdentifier: harnessBundleId)
        found += NSWorkspace.shared.runningApplications.filter {
            $0.bundleURL?.lastPathComponent == "DeepSeek Harness.app"
        }
        var seen = Set<pid_t>()
        return found.filter { seen.insert($0.processIdentifier).inserted }
    }

    private func focusHarness() {
        let apps = harnessCandidates().filter { $0.activationPolicy == .regular }
        guard let app = apps.first else {
            logLine("focus: harness app not found (harness \(harnessPid), parent \(parentPid))")
            return
        }
        if app.isHidden { app.unhide() }
        var raised = app.activate(options: [.activateAllWindows])
        if !raised || !app.isActive {
            raised = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        }
        logLine("focus: \(app.localizedName ?? "?") pid \(app.processIdentifier) active \(app.isActive) raised \(raised)")
    }

    // MARK: - page bridge

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "hitbox":
            var next: [CGRect] = []
            if let pet = rectangle(body["pet"]) { next.append(pet) }
            if let panelRect = rectangle(body["panel"]) { next.append(panelRect) }
            if next.count != hits.count { logLine("hitboxes: \(next.map { NSStringFromRect($0) })") }
            hits = next
        case "drag":
            let dx = (body["dx"] as? NSNumber)?.doubleValue ?? 0
            let dy = (body["dy"] as? NSNumber)?.doubleValue ?? 0
            move(by: dx, dy: dy)
        case "park":
            park()
        case "focus":
            focusHarness()
        case "install":
            logLine("install: button pressed (\(body["slug"] as? String ?? "-"))")
            var payload: [String: Any] = ["action": "install-skin"]
            if let slug = body["slug"] as? String, !slug.isEmpty { payload["slug"] = slug }
            writeCommand(payload)
        case "switch":
            if let slug = body["slug"] as? String, !slug.isEmpty {
                logLine("switch: \(slug)")
                writeCommand(["action": "switch-skin", "slug": slug])
            }
        case "delete":
            if let slug = body["slug"] as? String, !slug.isEmpty {
                logLine("delete: \(slug)")
                writeCommand(["action": "delete-skin", "slug": slug])
            }
        case "new-skin":
            logLine("new skin requested")
            writeCommand(["action": "new-skin"])
        case "error":
            let message = body["message"] as? String ?? "?"
            let source = body["source"] as? String ?? ""
            let line = (body["line"] as? NSNumber)?.intValue ?? 0
            logLine("page error: \(message) @ \(source):\(line)")
        case "debug":
            logLine("page debug: \(body["message"] as? String ?? "?")")
        default:
            logLine("unknown message \(type)")
        }
    }

    private func rectangle(_ value: Any?) -> CGRect? {
        guard let dict = value as? [String: Any],
              let x = (dict["x"] as? NSNumber)?.doubleValue,
              let y = (dict["y"] as? NSNumber)?.doubleValue,
              let w = (dict["w"] as? NSNumber)?.doubleValue,
              let h = (dict["h"] as? NSNumber)?.doubleValue,
              w > 0, h > 0 else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        documentReady = true
        logLine("page finished")
        if !snapshotPath.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in self?.saveSnapshot() }
        }
        if !pendingState.isEmpty {
            let next = pendingState
            pendingState = ""
            inject(next)
        }
        injectSkin()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        logLine("page failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        logLine("page failed to start: \(error.localizedDescription) \(pageURL.path)")
    }

    private func saveSnapshot() {
        let configuration = WKSnapshotConfiguration()
        configuration.rect = NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight)
        web.takeSnapshot(with: configuration) { [weak self] image, error in
            guard let self = self else { return }
            guard let image = image, let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                self.log("snapshot failed: \(error?.localizedDescription ?? "no image")")
                return
            }
            try? png.write(to: URL(fileURLWithPath: snapshotPath))
            self.log("snapshot written")
        }
    }

    func log(_ text: String) {
        logLine(text)
    }

    private var bridgeSource: String {
        return """
        window.pet = {
          onState: function (callback) { window.__petState = callback; },
          drag: function (delta) {
            window.webkit.messageHandlers.pet.postMessage({ type: 'drag', dx: delta.dx, dy: delta.dy });
          },
          park: function () { window.webkit.messageHandlers.pet.postMessage({ type: 'park' }); },
          interactive: function () {},
          focusHarness: function () { window.webkit.messageHandlers.pet.postMessage({ type: 'focus' }); },
          install: function (slug) { window.webkit.messageHandlers.pet.postMessage({ type: 'install', slug: slug || '' }); },
          switchSkin: function (slug) { window.webkit.messageHandlers.pet.postMessage({ type: 'switch', slug: slug || '' }); },
          deleteSkin: function (slug) { window.webkit.messageHandlers.pet.postMessage({ type: 'delete', slug: slug || '' }); },
          newSkin: function () { window.webkit.messageHandlers.pet.postMessage({ type: 'new-skin' }); }
        };
        window.addEventListener('error', function (event) {
          try {
            window.webkit.messageHandlers.pet.postMessage({
              type: 'error',
              message: String(event.message || event),
              source: String(event.filename || ''),
              line: Number(event.lineno || 0)
            });
          } catch (error) { /* logging is best-effort */ }
        }, true);
        window.addEventListener('unhandledrejection', function (event) {
          try {
            window.webkit.messageHandlers.pet.postMessage({
              type: 'error',
              message: 'unhandled rejection: ' + String(event.reason)
            });
          } catch (error) { /* logging is best-effort */ }
        });
        """
    }
}

// CLI mode: report how many frames each row actually uses. Petdex sheets leave
// unused cells empty, and stepping into one blinks the pet, so the frame count
// is measured once at build time instead of guessed from the grid.
/// Pixel size of the sheet, straight from the image header.
func imageSize(_ path: String) -> (width: Int, height: Int)? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
          width > 0, height > 0 else { return nil }
    return (width, height)
}

/// Frames are 192×208 by convention; an 8×11 v2 sheet must not be squashed to
/// nine rows, so the grid follows the actual sheet size.
func skinGrid(width: Int, height: Int) -> (columns: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
    if width % 192 == 0 && height % 208 == 0 {
        return (max(1, width / 192), max(1, height / 208), 192, 208)
    }
    let columns = 8
    let cellWidth = max(1, width / columns)
    let rows = max(1, Int((Double(height) / (Double(cellWidth) * 208.0 / 192.0)).rounded()))
    return (columns, rows, cellWidth, max(1, height / rows))
}

func frameCounts(sheet path: String, columns: Int, rows: Int, cellWidth: Int, cellHeight: Int) -> [Int]? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    let bytesPerRow = cellWidth * 4
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bytesPerRow * cellHeight)
    defer { buffer.deallocate() }
    guard let context = CGContext(data: buffer, width: cellWidth, height: cellHeight,
                                  bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    var counts: [Int] = []
    for row in 0..<rows {
        var last = 0
        for column in 0..<columns {
            context.clear(CGRect(x: 0, y: 0, width: cellWidth, height: cellHeight))
            context.draw(image, in: CGRect(x: -CGFloat(column * cellWidth),
                                           y: -CGFloat((rows - 1 - row) * cellHeight),
                                           width: CGFloat(columns * cellWidth),
                                           height: CGFloat(rows * cellHeight)))
            var opaque = 0
            var index = 3
            while index < bytesPerRow * cellHeight {
                if buffer[index] > 80 { opaque += 1 }
                index += 28
            }
            if opaque > 24 { last = column + 1 } else if last > 0 { break }
        }
        counts.append(max(1, last))
    }
    return counts
}

if let flag = CommandLine.arguments.firstIndex(of: "--frames") {
    let args = CommandLine.arguments
    guard args.count >= flag + 6 else { exit(2) }
    let sheet = args[flag + 1]
    let columns = Int(args[flag + 2]) ?? 8
    let rows = Int(args[flag + 3]) ?? 9
    let cellWidth = Int(args[flag + 4]) ?? 192
    let cellHeight = Int(args[flag + 5]) ?? 208
    guard let counts = frameCounts(sheet: sheet, columns: columns, rows: rows,
                                   cellWidth: cellWidth, cellHeight: cellHeight) else { exit(1) }
    print(counts.map(String.init).joined(separator: ","))
    exit(0)
}

let application = NSApplication.shared
let delegate = PetApp()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
