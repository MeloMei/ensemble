import AVFoundation
import Foundation
import Speech

struct DictationMessage: Encodable {
    let type: String
    var text: String? = nil
    var reason: String? = nil
}

final class Dictation {
    private lazy var engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var finished = false
    private var commands = Data()

    func start(locale: Locale) {
        guard let recognizer = SFSpeechRecognizer(locale: locale),
              recognizer.locale.languageCode == locale.languageCode,
              recognizer.locale.regionCode == locale.regionCode,
              recognizer.supportsOnDeviceRecognition else {
            fail("language")
        }
        self.recognizer = recognizer
        FileHandle.standardInput.readabilityHandler = { input in
            let bytes = input.availableData
            DispatchQueue.main.async { self.receive(bytes) }
        }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { self.fail("speechPermission") }
                guard recognizer.isAvailable else { self.fail("recognizerUnavailable") }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard granted else { self.fail("microphonePermission") }
                        self.record(using: recognizer)
                    }
                }
            }
        }
    }

    private func record(using recognizer: SFSpeechRecognizer) {
        guard recognizer.supportsOnDeviceRecognition else { fail("language") }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { fail("microphoneUnavailable") }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        self.request = request
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                if let result, result.isFinal {
                    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { self.fail("noSpeech") }
                    self.complete(DictationMessage(type: "final", text: text))
                } else if error != nil {
                    self.fail("recognizerUnavailable")
                }
            }
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        tapInstalled = true
        engine.prepare()
        do { try engine.start() }
        catch { fail("microphoneUnavailable") }
        send(DictationMessage(type: "ready"))
    }

    private func receive(_ bytes: Data) {
        guard !bytes.isEmpty else { complete(nil) }
        commands.append(bytes)
        guard commands.count <= 5 else { complete(nil) }
        guard commands == Data("stop\n".utf8) else { return }
        guard let request else { complete(nil) }
        stopInput()
        request.endAudio()
    }

    private func stopInput() {
        if tapInstalled {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }

    private func send(_ message: DictationMessage) {
        guard let bytes = try? JSONEncoder().encode(message) else { exit(EXIT_FAILURE) }
        FileHandle.standardOutput.write(bytes + Data([0x0A]))
    }

    private func fail(_ reason: String) -> Never {
        complete(DictationMessage(type: "error", reason: reason))
    }

    private func complete(_ message: DictationMessage?) -> Never {
        guard !finished else { exit(EXIT_FAILURE) }
        finished = true
        FileHandle.standardInput.readabilityHandler = nil
        stopInput()
        task?.cancel()
        if let message { send(message) }
        exit(EXIT_SUCCESS)
    }
}

guard CommandLine.arguments.count == 2 else { exit(EXIT_FAILURE) }
let dictation = Dictation()
dictation.start(locale: Locale(identifier: CommandLine.arguments[1]))
RunLoop.main.run()
