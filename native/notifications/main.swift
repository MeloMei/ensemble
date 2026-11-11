import AppKit
import Foundation
import UserNotifications

private let maxInputBytes = 8192
private let linkKey = "ensembleNotificationLink"
private let dataPathKey = "ensembleDataPath"
private let linkPrefix = "ensemble-notification://session?"

private enum Operation: String, Decodable { case status, authorize, deliver }
private enum Authorization: String, Encodable {
    case authorized, denied, unsupported
    case notDetermined = "not-determined"

    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional: self = .authorized
        case .denied: self = .denied
        case .notDetermined: self = .notDetermined
        default: self = .unsupported
        }
    }
}

private struct Notice: Decodable {
    let id: String
    let title: String
    let body: String
    let silent: Bool
    let link: String
    let dataPath: String

    var valid: Bool {
        id.utf8.count == 64 && id.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
            && !title.isEmpty && title.utf8.count <= 512 && body.utf8.count <= 2048
            && link.hasPrefix(linkPrefix) && link.utf8.count <= 4096
            && validDataPath(dataPath)
    }
}

private func validDataPath(_ path: String) -> Bool {
    path.hasPrefix("/") && path.utf8.count <= 1024 && !path.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
}

private struct Request: Decodable {
    let operation: Operation
    let notice: Notice?
}

private struct Reply: Encodable { let authorization: Authorization }
private enum RequestError: Error { case invalidInput }

private func readRequest() throws -> Request {
    let input = FileHandle.standardInput
    var data = Data()
    while let chunk = try input.read(upToCount: maxInputBytes + 1 - data.count), !chunk.isEmpty {
        data.append(chunk)
        if data.count > maxInputBytes { throw RequestError.invalidInput }
    }
    return try JSONDecoder().decode(Request.self, from: data)
}

private final class ClickDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { NSApp.terminate(nil) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let link = userInfo[linkKey] as? String, link.hasPrefix(linkPrefix), link.utf8.count <= 4096,
              let dataPath = userInfo[dataPathKey] as? String, validDataPath(dataPath) else { completionHandler(); return }
        let desktop = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard Bundle(url: desktop)?.bundleIdentifier == "local.agent-workbench.desktop" else { completionHandler(); return }
        Task { @MainActor in
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            config.promptsUserIfNeeded = false
            config.createsNewApplicationInstance = true
            config.environment = ["WORKBENCH_DATA_DIR": dataPath]
            config.arguments = ["--ensemble-notification=\(link)"]
            _ = try? await NSWorkspace.shared.openApplication(at: desktop, configuration: config)
            completionHandler()
        }
    }
}

@main
enum EnsembleNotifications {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--stdio"] {
            Task { await runStdio(); exit(0) }
            dispatchMain()
        }
        guard arguments.isEmpty else { exit(1) }
        let app = NSApplication.shared
        let delegate = ClickDelegate()
        app.delegate = delegate
        UNUserNotificationCenter.current().delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }

    private static func runStdio() async {
        do {
            let request = try readRequest()
            let center = UNUserNotificationCenter.current()
            var settings = await center.notificationSettings()
            if request.operation == .authorize && settings.authorizationStatus == .notDetermined {
                _ = try await center.requestAuthorization(options: [.alert, .sound])
                settings = await center.notificationSettings()
            }
            let authorization = Authorization(settings.authorizationStatus)
            if request.operation == .deliver {
                guard let notice = request.notice, notice.valid else { throw RequestError.invalidInput }
                if authorization == .authorized {
                    let content = UNMutableNotificationContent()
                    content.title = notice.title
                    content.body = notice.body
                    content.userInfo[linkKey] = notice.link
                    content.userInfo[dataPathKey] = notice.dataPath
                    if !notice.silent && settings.soundSetting == .enabled { content.sound = .default }
                    try await center.add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil))
                }
            }
            let reply = try JSONEncoder().encode(Reply(authorization: authorization))
            FileHandle.standardOutput.write(reply + Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("Ensemble Notifications failed.\n".utf8))
            exit(1)
        }
    }
}
