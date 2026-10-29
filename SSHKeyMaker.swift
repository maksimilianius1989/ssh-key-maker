import SwiftUI
import AppKit

// MARK: - Зовнішні команди

struct RunResult {
    let code: Int32
    let output: String
}

func run(_ path: String, _ args: [String], env extra: [String: String] = [:]) -> RunResult {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    extra.forEach { env[$0.key] = $0.value }
    p.environment = env
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch {
        return RunResult(code: -1, output: "Не вдалося запустити \(path): \(error.localizedDescription)")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return RunResult(code: p.terminationStatus, output: String(decoding: data, as: UTF8.self))
}

/// Застосунок, запущений з Finder, не бачить PATH оболонки, тому теки перелічено явно.
/// Системні /usr/bin — першими: лише там ssh-add знає --apple-use-keychain.
let toolDirs = ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"]

func requiredTools(_ mode: Mode) -> [String] {
    mode == .full ? ["ssh-keygen", "ssh-copy-id", "ssh", "ssh-add"] : ["ssh-keygen"]
}

func findTool(_ name: String) -> String? {
    toolDirs.map { "\($0)/\(name)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
}

struct Tools {
    let keygen, copyId, ssh, add: String
    var systemAdd: Bool { add == "/usr/bin/ssh-add" }

    /// Шукає лише потрібні режиму команди; решта лишається порожньою.
    static func resolve(_ mode: Mode) -> Tools? {
        guard requiredTools(mode).allSatisfy({ findTool($0) != nil }) else { return nil }
        let f = { (n: String) in findTool(n) ?? "" }
        return Tools(keygen: f("ssh-keygen"), copyId: f("ssh-copy-id"), ssh: f("ssh"), add: f("ssh-add"))
    }
}

/// Тимчасовий скрипт SSH_ASKPASS: віддає ssh секрет зі змінної оточення,
/// щоб пароль не потрапляв в аргументи команди.
func makeAskpass() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("sshkm-askpass-\(UUID().uuidString).sh")
    try "#!/bin/sh\nprintf '%s\\n' \"$SSHKM_SECRET\"\n".write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    return url
}

@MainActor
func ask(_ title: String, _ text: String, ok: String) -> Bool {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.addButton(withTitle: ok)
    a.addButton(withTitle: "Скасувати")
    return a.runModal() == .alertFirstButtonReturn
}

// MARK: - Стан

/// Що робити з ключем після створення.
enum Mode: String, CaseIterable, Identifiable {
    case files, sshDir, full
    var id: Self { self }
    var title: String {
        switch self {
        case .files: return "Лише ключі (keys)"
        case .sshDir: return "Ключі в ~/.ssh"
        case .full: return "Повне налаштування"
        }
    }
}

/// Тека keys поруч із проєктом. build.sh записує шлях проєкту в Info.plist,
/// бо сам .app можуть перенести в «Програми», де писати не можна.
let projectKeysDir: URL = {
    if let dir = Bundle.main.object(forInfoDictionaryKey: "SSHKMProjectDir") as? String, !dir.isEmpty {
        return URL(fileURLWithPath: dir).appendingPathComponent("keys")
    }
    return Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("keys")
}()

enum Lamp {
    case idle, working, ok, fail
    var color: Color {
        switch self {
        case .idle: return .gray
        case .working: return .yellow
        case .ok: return .green
        case .fail: return .red
        }
    }
    var text: String {
        switch self {
        case .idle: return "Очікує"
        case .working: return "Виконується…"
        case .ok: return "З'єднання працює"
        case .fail: return "Помилка"
        }
    }
}

@MainActor
final class Model: ObservableObject {
    @Published var mode: Mode = .full
    @Published var name = ""
    @Published var host = ""
    @Published var port = "22"
    @Published var user = ""
    @Published var serverPassword = ""
    @Published var passphrase = ""
    @Published var publicKey = ""
    @Published var keyPath: URL?
    @Published var log = ""
    @Published var lamp: Lamp = .idle
    @Published var busy = false

    let sshDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh")
    var keyDir: URL { mode == .files ? projectKeysDir : sshDir }

    var lampText: String {
        lamp == .ok && mode != .full ? "Ключі створено" : lamp.text
    }

    func append(_ s: String) { log += s.hasSuffix("\n") ? s : s + "\n" }

    func validate() -> String? {
        let n = name.trimmingCharacters(in: .whitespaces)
        if n.isEmpty || n.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) == nil {
            return "Назва: лише латиниця, цифри, крапка, дефіс, підкреслення."
        }
        if mode != .full { return nil }
        if host.trimmingCharacters(in: .whitespaces).isEmpty || host.contains(" ") { return "Вкажіть хост без пробілів." }
        guard let p = Int(port), (1...65535).contains(p) else { return "Порт — число від 1 до 65535." }
        if user.trimmingCharacters(in: .whitespaces).isEmpty || user.contains(" ") { return "Вкажіть користувача на сервері." }
        if serverPassword.isEmpty { return "Потрібен пароль від сервера — щоб залити ключ." }
        return nil
    }

    func fail(_ s: String) {
        append("✗ \(s)")
        lamp = .fail
        busy = false
    }

    func generate() {
        log = ""
        if let err = validate() { fail(err); return }
        busy = true
        lamp = .working
        publicKey = ""
        keyPath = nil
        Task { await ensureToolsThenRun() }
    }

    /// Бракує команд — питаємо і ставимо OpenSSH через Homebrew; немає Homebrew — пропонуємо його встановити.
    func ensureToolsThenRun() async {
        if let tools = Tools.resolve(mode) { start(tools); return }

        let missing = requiredTools(mode).filter { findTool($0) == nil }
        append("⚠︎ Не знайдено: \(missing.joined(separator: ", "))")

        guard let brew = findTool("brew") else {
            if ask("Немає Homebrew",
                   "Для встановлення \(missing.joined(separator: ", ")) потрібен менеджер пакетів Homebrew. Відкрити Термінал із командою його встановлення? Після встановлення натисніть «Згенерувати» ще раз.",
                   ok: "Відкрити Термінал") {
                let cmd = "/bin/bash -c \\\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\\""
                _ = run("/usr/bin/osascript", ["-e", "tell application \"Terminal\" to do script \"\(cmd)\"",
                                               "-e", "tell application \"Terminal\" to activate"])
                fail("Встановіть Homebrew у Терміналі й повторіть.")
            } else {
                fail("Без \(missing.joined(separator: ", ")) продовжити не можу.")
            }
            return
        }

        guard ask("Встановити OpenSSH?",
                  "Бракує команд: \(missing.joined(separator: ", ")). Встановити пакет openssh через Homebrew (brew install openssh)?",
                  ok: "Встановити") else {
            fail("Встановлення скасовано.")
            return
        }
        append("→ brew install openssh… (може тривати кілька хвилин)")
        let r = await Task.detached { run(brew, ["install", "openssh"], env: ["NONINTERACTIVE": "1"]) }.value
        append(r.output.trimmingCharacters(in: .whitespacesAndNewlines))
        guard r.code == 0, let tools = Tools.resolve(mode) else {
            fail("Встановлення не вдалося (код \(r.code)).")
            return
        }
        append("✓ OpenSSH встановлено.")
        start(tools)
    }

    func start(_ tools: Tools) {
        let n = name.trimmingCharacters(in: .whitespaces)
        let h = host.trimmingCharacters(in: .whitespaces)
        let u = user.trimmingCharacters(in: .whitespaces)
        let pt = port, pw = serverPassword, pp = passphrase, md = mode, kd = keyDir, sd = sshDir

        Task.detached {
            let ok = await Self.pipeline(tools: tools, mode: md, name: n, host: h, port: pt, user: u,
                                         password: pw, passphrase: pp, keyDir: kd, sshDir: sd) { line in
                await MainActor.run { self.append(line) }
            } showKey: { key, path in
                await MainActor.run { self.publicKey = key; self.keyPath = path }
            }
            await MainActor.run {
                self.lamp = ok ? .ok : .fail
                self.busy = false
                self.serverPassword = ""
            }
        }
    }

    nonisolated static func pipeline(tools: Tools, mode: Mode, name: String, host: String, port: String, user: String,
                                     password: String, passphrase: String, keyDir: URL, sshDir: URL,
                                     say: @escaping (String) async -> Void,
                                     showKey: @escaping (String, URL) async -> Void) async -> Bool {
        let fm = FileManager.default
        let key = keyDir.appendingPathComponent("id_ed25519_\(name)")
        let pub = URL(fileURLWithPath: key.path + ".pub")
        let config = sshDir.appendingPathComponent("config")

        // 1. Тека ключів і перевірки, щоб нічого не перезаписати
        do {
            if !fm.fileExists(atPath: keyDir.path) {
                try fm.createDirectory(at: keyDir, withIntermediateDirectories: true)
                try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: keyDir.path)
            }
            // Тека keys у проєкті: щоб приватні ключі не потрапили в git
            let ignore = keyDir.appendingPathComponent(".gitignore")
            if mode == .files && !fm.fileExists(atPath: ignore.path) {
                try "*\n".write(to: ignore, atomically: true, encoding: .utf8)
            }
        } catch {
            await say("✗ Не вдалося створити \(keyDir.path): \(error.localizedDescription)")
            return false
        }
        if fm.fileExists(atPath: key.path) || fm.fileExists(atPath: pub.path) {
            await say("✗ Ключ \(key.path) уже існує. Оберіть іншу назву — наявний ключ не перезаписую.")
            return false
        }
        let existing = (try? String(contentsOf: config, encoding: .utf8)) ?? ""
        let hostTaken = existing.split(separator: "\n").contains { line in
            let parts = line.trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0 == " " || $0 == "\t" })
            return parts.first?.lowercased() == "host" && parts.dropFirst().contains { String($0) == name }
        }
        if mode == .full && hostTaken {
            await say("✗ У ~/.ssh/config уже є запис Host \(name). Оберіть іншу назву.")
            return false
        }

        // 2. Ключ
        await say("→ Створюю ключ \(key.path)…")
        let comment = mode == .full ? "\(user)@\(name)" : name
        let gen = run(tools.keygen, ["-t", "ed25519", "-f", key.path, "-N", passphrase, "-C", comment])
        if gen.code != 0 {
            await say("✗ ssh-keygen:\n\(gen.output)")
            return false
        }
        let pubText = ((try? String(contentsOf: pub, encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        await showKey(pubText, key)
        await say("✓ Ключ створено.")
        guard mode == .full else {
            await say("✓ Готово. Приватний: \(key.path)\n  Публічний: \(pub.path)")
            return true
        }

        // 3. Запис у кінець config (з резервною копією)
        do {
            if fm.fileExists(atPath: config.path) {
                let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
                let backup = sshDir.appendingPathComponent("config.bak-\(stamp)")
                try fm.copyItem(at: config, to: backup)
                await say("✓ Резервна копія конфігу: \(backup.path)")
            }
            var block = existing.isEmpty || existing.hasSuffix("\n") ? "" : "\n"
            if !existing.isEmpty { block += "\n" }
            // IgnoreUnknown — щоб ssh не з Apple (Homebrew) не падав на UseKeychain
            block += """
            Host \(name)
                HostName \(host)
                Port \(port)
                User \(user)
                IdentityFile ~/.ssh/id_ed25519_\(name)
                IdentitiesOnly yes
                AddKeysToAgent yes
                IgnoreUnknown UseKeychain
                UseKeychain yes

            """
            try (existing + block).write(to: config, atomically: true, encoding: .utf8)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
            await say("✓ Додано Host \(name) у кінець ~/.ssh/config.")
        } catch {
            await say("✗ Не вдалося записати config: \(error.localizedDescription)")
            return false
        }

        let askpass: URL
        do { askpass = try makeAskpass() } catch {
            await say("✗ Не вдалося підготувати askpass: \(error.localizedDescription)")
            return false
        }
        defer { try? fm.removeItem(at: askpass) }
        let askEnv = ["SSH_ASKPASS": askpass.path, "SSH_ASKPASS_REQUIRE": "force", "DISPLAY": ":0"]

        // 4. Ключ із паролем — в агент (і «Зв'язку ключів»), щоб далі не питало
        if !passphrase.isEmpty {
            await say("→ Додаю ключ в агент…")
            var env = askEnv
            env["SSHKM_SECRET"] = passphrase
            let args = tools.systemAdd ? ["--apple-use-keychain", key.path] : [key.path]
            let add = run(tools.add, args, env: env)
            await say(add.code == 0 ? "✓ Ключ в агенті." : "⚠︎ ssh-add:\n\(add.output)")
        }

        // 5. Залити ключ на сервер
        await say("→ Заливаю ключ на \(user)@\(host):\(port)…")
        var copyEnv = askEnv
        copyEnv["SSHKM_SECRET"] = password
        // ssh-copy-id — shell-скрипт, що кличе ssh з PATH: підкладаємо теку обраного ssh першою
        let sshDirPath = (tools.ssh as NSString).deletingLastPathComponent
        copyEnv["PATH"] = "\(sshDirPath):/usr/bin:/bin:/usr/sbin:/sbin"
        let copy = run(tools.copyId,
                       ["-i", pub.path, "-p", port,
                        "-o", "StrictHostKeyChecking=accept-new",
                        "-o", "ConnectTimeout=15",
                        "-o", "PreferredAuthentications=publickey,password,keyboard-interactive",
                        "-o", "NumberOfPasswordPrompts=1",
                        "\(user)@\(host)"],
                       env: copyEnv)
        await say(copy.output.trimmingCharacters(in: .whitespacesAndNewlines))
        if copy.code != 0 {
            await say("✗ ssh-copy-id завершився з кодом \(copy.code).")
            return false
        }
        await say("✓ Ключ на сервері.")

        // 6. Перевірка: вхід лише за ключем, через новий запис конфігу
        await say("→ Перевіряю вхід: ssh \(name)…")
        let test = run(tools.ssh,
                       ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                        "-o", "StrictHostKeyChecking=accept-new",
                        name, "echo SSHKM_OK"])
        if test.code == 0 && test.output.contains("SSHKM_OK") {
            await say("✓ Вхід за ключем працює. Далі: ssh \(name)")
            return true
        }
        await say("✗ Вхід за ключем не вдався:\n\(test.output)")
        return false
    }
}

// MARK: - Інтерфейс

struct ContentView: View {
    @StateObject var m = Model()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Form {
                Picker("Режим:", selection: $m.mode) {
                    ForEach(Mode.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                TextField(m.mode == .full ? "Назва (Host у конфігу):" : "Назва ключа:", text: $m.name, prompt: Text("erp"))
                if m.mode == .full {
                    TextField("Хост:", text: $m.host, prompt: Text("176.103.114.151"))
                    TextField("Порт:", text: $m.port)
                    TextField("Користувач:", text: $m.user, prompt: Text("root"))
                    SecureField("Пароль сервера:", text: $m.serverPassword, prompt: Text("для заливання ключа"))
                }
                SecureField("Пароль ключа:", text: $m.passphrase, prompt: Text("необов'язково"))
                LabeledContent("Куди:") {
                    Text(m.mode == .full ? "\(m.keyDir.path) + config + сервер" : m.keyDir.path)
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            .disabled(m.busy)

            HStack(spacing: 12) {
                Button(action: m.generate) {
                    Text("Згенерувати").frame(minWidth: 120)
                }
                .keyboardShortcut(.defaultAction)
                .controlSize(.large)
                .disabled(m.busy)

                Circle()
                    .fill(m.lamp.color)
                    .frame(width: 18, height: 18)
                    .shadow(color: m.lamp.color.opacity(0.8), radius: m.lamp == .idle ? 0 : 6)
                Text(m.lampText).font(.headline)
                if m.busy { ProgressView().controlSize(.small) }
            }

            HStack {
                Text("Публічний ключ").font(.headline)
                Spacer()
                Button("Показати у Finder") {
                    if let k = m.keyPath { NSWorkspace.shared.activateFileViewerSelecting([k]) }
                }
                .disabled(m.keyPath == nil)
                Button("Копіювати") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(m.publicKey, forType: .string)
                }
                .disabled(m.publicKey.isEmpty)
            }
            ScrollView {
                Text(m.publicKey.isEmpty ? "—" : m.publicKey)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(height: 60)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))

            Text("Журнал").font(.headline)
            ScrollView {
                Text(m.log.isEmpty ? " " : m.log)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(minHeight: 160)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
        }
        .padding(20)
        .frame(minWidth: 560, minHeight: 620)
    }
}

@main
struct SSHKeyMakerApp: App {
    var body: some Scene {
        WindowGroup("SSH Key Maker") { ContentView() }
            .windowResizability(.contentMinSize)
    }
}
