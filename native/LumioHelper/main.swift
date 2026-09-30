// lumio-helper — native Mac control for Lumio Browser.
// Reads JSON lines on stdin ({id, cmd, ...}) and answers on stdout
// ({id, ok, ...} or {id, ok:false, error}). Coordinates are global screen
// points with the origin at the top-left of the main display (CGEvent space).
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import LocalAuthentication
import ScreenCaptureKit

let outQueue = DispatchQueue(label: "lumio.helper.out")

func send(_ obj: [String: Any]) {
    outQueue.async {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}
func reply(_ id: Any, _ result: [String: Any] = [:]) {
    var r = result
    r["id"] = id
    r["ok"] = true
    send(r)
}
func fail(_ id: Any, _ message: String) { send(["id": id, "ok": false, "error": message]) }

// MARK: - Permissions

func canPostEvents() -> Bool { AXIsProcessTrusted() || CGPreflightPostEventAccess() }
let inputOff = "Accessibility permission is off for Lumio Browser. Turn it on in System Settings → Privacy & Security → Accessibility, then reopen Lumio Browser."
let screenOff = "Screen Recording permission is off for Lumio Browser. Turn it on in System Settings → Privacy & Security → Screen Recording, then reopen Lumio Browser."

// MARK: - Displays

struct Display { let id: CGDirectDisplayID; let bounds: CGRect; let main: Bool }

func allDisplays() -> [Display] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.map { Display(id: $0, bounds: CGDisplayBounds($0), main: CGDisplayIsMain($0) != 0) }
}

func cursorLocation() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func pickDisplay(_ spec: Any?) -> Display? {
    let all = allDisplays()
    if let n = spec as? Int ?? (spec as? String).flatMap({ Int($0) }) {
        return all.first { Int($0.id) == n } ?? all.first { $0.main }
    }
    if let s = spec as? String, s == "main" { return all.first { $0.main } ?? all.first }
    let p = cursorLocation()
    return all.first { $0.bounds.contains(p) } ?? all.first { $0.main } ?? all.first
}

func describe(_ d: Display) -> [String: Any] {
    ["id": Int(d.id), "x": d.bounds.origin.x, "y": d.bounds.origin.y, "width": d.bounds.width, "height": d.bounds.height, "main": d.main]
}

// MARK: - Screenshot

func screenshot(_ id: Any, _ args: [String: Any]) {
    guard CGPreflightScreenCaptureAccess() else { fail(id, screenOff); return }
    guard let d = pickDisplay(args["display"]) else { fail(id, "No display found."); return }
    let maxWidth = (args["maxWidth"] as? Int) ?? 1440
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let scDisplay = content.displays.first(where: { $0.displayID == d.id }) else { fail(id, "That display isn't available."); return }
            let filter = SCContentFilter(display: scDisplay, excludingWindows: [])
            let config = SCStreamConfiguration()
            let width = min(maxWidth, Int(d.bounds.width.rounded()))
            let scale = Double(width) / Double(d.bounds.width)
            config.width = width
            config.height = Int((Double(d.bounds.height) * scale).rounded())
            config.showsCursor = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let rep = NSBitmapImageRep(cgImage: image)
            guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else { fail(id, "Couldn't encode the screenshot."); return }
            reply(id, [
                "image": jpeg.base64EncodedString(),
                "width": image.width,
                "height": image.height,
                "bounds": ["x": d.bounds.origin.x, "y": d.bounds.origin.y, "width": d.bounds.width, "height": d.bounds.height],
                "display": Int(d.id),
                "displays": allDisplays().map(describe),
                "frontmost": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
            ])
        } catch {
            fail(id, "Screenshot failed: \(error.localizedDescription)")
        }
    }
}

// MARK: - Mouse

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }
func pause(_ ms: UInt32) { usleep(ms * 1000) }

func point(_ args: [String: Any], _ kx: String = "x", _ ky: String = "y") -> CGPoint? {
    guard let x = (args[kx] as? NSNumber)?.doubleValue, let y = (args[ky] as? NSNumber)?.doubleValue else { return nil }
    return CGPoint(x: x, y: y)
}

func moveMouse(_ p: CGPoint) {
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
}

func click(_ p: CGPoint, right: Bool, count: Int) {
    let (downType, upType, button): (CGEventType, CGEventType, CGMouseButton) =
        right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    moveMouse(p)
    pause(40)
    for i in 1...max(1, min(3, count)) {
        let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: p, mouseButton: button)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(down)
        pause(20)
        let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: p, mouseButton: button)
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(up)
        pause(50)
    }
}

func drag(from: CGPoint, to: CGPoint) {
    moveMouse(from)
    pause(40)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
    let steps = 24
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
        pause(12)
    }
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
}

func scroll(at p: CGPoint, dx: Int32, dy: Int32) {
    moveMouse(p)
    pause(30)
    post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
}

// MARK: - Keyboard

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
    ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "left": 123, "right": 124,
    "down": 125, "up": 126, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111, "plus": 24, "minus": 27,
]

func pressKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    post(down)
    pause(15)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = flags
    post(up)
}

func pressCombo(_ combo: String) -> String? {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for raw in combo.lowercased().split(separator: "+") {
        let part = raw.trimmingCharacters(in: .whitespaces)
        switch part {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default:
            guard let code = keyCodes[part] else { return "Unknown key \"\(part)\"." }
            key = code
        }
    }
    guard let code = key else { return "No key in \"\(combo)\"." }
    pressKey(code, flags: flags)
    return nil
}

func typeText(_ text: String) {
    for ch in text {
        if ch == "\n" || ch == "\r" { pressKey(36); pause(12); continue }
        if ch == "\t" { pressKey(48); pause(12); continue }
        let units = Array(String(ch).utf16)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        post(down)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        post(up)
        pause(6)
    }
}

// MARK: - Apps and windows

func appsAndWindows() -> [String: Any] {
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .map { app -> [String: Any] in
            ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "active": app.isActive, "hidden": app.isHidden]
        }
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let windows = info
        .filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
        .map { w -> [String: Any] in
            ["owner": w[kCGWindowOwnerName as String] as? String ?? "", "title": w[kCGWindowName as String] as? String ?? "", "bounds": w[kCGWindowBounds as String] ?? [:]]
        }
    return ["apps": apps, "windows": windows]
}

// MARK: - Confirming the person (Touch ID, or the Mac login password)

func authenticate(_ id: Any, reason: String) {
    let context = LAContext()
    var error: NSError?
    // deviceOwnerAuthentication = Touch ID / Apple Watch, falling back to the login password.
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        reply(id, ["authenticated": false, "unavailable": true, "reason": error?.localizedDescription ?? "Unavailable"])
        return
    }
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
        reply(id, ["authenticated": ok, "cancelled": (err as? LAError)?.code == .userCancel])
    }
}

// MARK: - Dispatch

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = msg["cmd"] as? String else { return }
    let id = msg["id"] ?? NSNull()
    let needsInput: Set<String> = ["move", "click", "drag", "scroll", "type", "key"]
    if needsInput.contains(cmd) && !canPostEvents() { fail(id, inputOff); return }

    switch cmd {
    case "ping":
        reply(id, ["pong": true])
    case "permissions":
        reply(id, ["accessibility": canPostEvents(), "screen": CGPreflightScreenCaptureAccess()])
    case "request_permissions":
        if (msg["which"] as? String) == "screen" {
            _ = CGRequestScreenCaptureAccess()
        } else {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
            _ = CGRequestPostEventAccess()
        }
        reply(id)
    case "displays":
        reply(id, ["displays": allDisplays().map(describe), "cursor": ["x": cursorLocation().x, "y": cursorLocation().y]])
    case "screenshot":
        screenshot(id, msg)
    case "move":
        guard let p = point(msg) else { fail(id, "x and y are required."); return }
        moveMouse(p)
        reply(id)
    case "click":
        guard let p = point(msg) else { fail(id, "x and y are required."); return }
        click(p, right: (msg["button"] as? String) == "right", count: (msg["count"] as? Int) ?? 1)
        reply(id)
    case "drag":
        guard let a = point(msg, "x1", "y1"), let b = point(msg, "x2", "y2") else { fail(id, "x1, y1, x2, y2 are required."); return }
        drag(from: a, to: b)
        reply(id)
    case "scroll":
        guard let p = point(msg) else { fail(id, "x and y are required."); return }
        scroll(at: p, dx: Int32((msg["dx"] as? Int) ?? 0), dy: Int32((msg["dy"] as? Int) ?? 0))
        reply(id)
    case "type":
        typeText(msg["text"] as? String ?? "")
        reply(id)
    case "key":
        if let err = pressCombo(msg["combo"] as? String ?? "") { fail(id, err) } else { reply(id) }
    case "apps":
        DispatchQueue.main.async { reply(id, appsAndWindows()) }
    case "authenticate":
        let reason = String((msg["reason"] as? String ?? "confirm it’s you").prefix(120))
        authenticate(id, reason: reason)
    default:
        fail(id, "Unknown command \(cmd).")
    }
}

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        handle(line)
    }
    exit(0)
}
reader.start()
RunLoop.main.run()
