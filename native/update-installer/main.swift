import AppKit
import Darwin

func localized(_ chinese: String, _ english: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("zh") == true ? chinese : english
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("Ensemble Installer: \(message)\n".utf8))
    exit(1)
}

func launchApplication(_ arguments: [String]) {
    guard arguments.count == 2 || arguments.count == 3 else {
        fail("Usage: --launch-app <bundle> <dataPath> [token]")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.promptsUserIfNeeded = false
    var environment = ["WORKBENCH_DATA_DIR": arguments[1]]
    if arguments.count == 3 {
        environment["WORKBENCH_UPDATE_TOKEN"] = arguments[2]
    }
    configuration.environment = environment
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        fail("LaunchServices did not finish opening the application within 30 seconds.")
    }
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: arguments[0]), configuration: configuration) { application, error in
        DispatchQueue.main.async {
            guard let application, application.processIdentifier > 0 else {
                fail(error?.localizedDescription ?? "LaunchServices did not return an application PID.")
            }
            FileHandle.standardOutput.write(Data("\(application.processIdentifier)\n".utf8))
            exit(0)
        }
    }
    RunLoop.main.run()
}

final class InstallerDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let arguments: [String]
    private var window: NSWindow!
    private var process: Process?
    private var log: FileHandle?
    private var installing = true

    init(arguments: [String]) {
        self.arguments = arguments
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        menu.addItem(applicationItem)
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "Quit Ensemble Installer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Ensemble Installer"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        let progress = NSProgressIndicator()
        progress.style = .spinning
        progress.controlSize = .regular
        progress.startAnimation(nil)
        let title = NSTextField(labelWithString: localized("正在安装 Ensemble \(arguments[7])…", "Installing Ensemble \(arguments[7])…"))
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        let detail = NSTextField(wrappingLabelWithString: localized("安装完成后将自动打开 Ensemble。", "Ensemble will open when installation finishes."))
        detail.textColor = .secondaryLabelColor
        detail.font = .systemFont(ofSize: 13)
        let text = NSStackView(views: [title, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 10
        let content = NSStackView(views: [progress, text])
        content.orientation = .horizontal
        content.alignment = .centerY
        content.spacing = 20
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
            content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
            content.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor)
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startInstallation()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if installing {
            window.makeKeyAndOrderFront(nil)
            NSSound.beep()
            return .terminateCancel
        }
        return .terminateNow
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { !installing }

    private func startInstallation() {
        do {
            guard let script = Bundle.main.url(forResource: "apply-app-update", withExtension: "sh") else {
                throw NSError(domain: "EnsembleInstaller", code: 1, userInfo: [NSLocalizedDescriptionKey: localized("安装脚本缺失。请重新下载 Ensemble。", "The installation script is missing. Please download Ensemble again.")])
            }
            let updates = URL(fileURLWithPath: arguments[5]).appendingPathComponent("updates", isDirectory: true)
            try FileManager.default.createDirectory(at: updates, withIntermediateDirectories: true)
            let descriptor = open(updates.appendingPathComponent("installer.log").path, O_WRONLY | O_CREAT | O_APPEND, S_IRUSR | S_IWUSR)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let log = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            self.log = log
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = [script.path] + arguments
            process.currentDirectoryURL = URL(fileURLWithPath: "/", isDirectory: true)
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = log
            process.standardError = log
            process.terminationHandler = { [weak self] process in
                let status = process.terminationReason == .exit ? process.terminationStatus : 128 + process.terminationStatus
                DispatchQueue.main.async { self?.finish(status: status) }
            }
            self.process = process
            try process.run()
        } catch {
            finish(status: 1, error: error.localizedDescription)
        }
    }

    private func finish(status: Int32, error: String? = nil) {
        installing = false
        if let error {
            let message = Data("Ensemble Installer: \(error)\n".utf8)
            log?.write(message)
            FileHandle.standardError.write(message)
        }
        try? log?.close()
        if status != 0 {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = localized("Ensemble 更新未完成", "Ensemble could not be updated")
            alert.informativeText = error ?? localized("安装程序未能完成更新（状态 \(status)）。请重新打开 Ensemble 查看更新结果。", "The installer did not finish (status \(status)). Reopen Ensemble to see the update result.")
            alert.addButton(withTitle: localized("关闭", "Close"))
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
        exit(status)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--launch-app" {
    launchApplication(Array(arguments.dropFirst()))
    fail("LaunchServices event loop exited before launch completed.")
}
guard arguments.count == 8 else {
    fail("Expected live, staged, backup, guiPID, backendPID, dataPath, token, version.")
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = InstallerDelegate(arguments: arguments)
application.delegate = delegate
application.run()
