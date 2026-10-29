// SSH Key Maker — Electron-версія (macOS, Windows, Linux). Логіка — за AGENTS.md.
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron')
const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''

const SSH_DIR = path.join(os.homedir(), '.ssh')
// Тека проєкту — над теками electron/; SSHKM_PROJECT_DIR дозволяє її перевизначити
const PROJECT_DIR = process.env.SSHKM_PROJECT_DIR || path.resolve(__dirname, '..')
const PROJECT_KEYS_DIR = path.join(PROJECT_DIR, 'keys')
const ICON = path.join(PROJECT_DIR, 'icons', 'hicolor', '512x512', 'apps', 'ssh-key-maker.png')

let win

// MARK: - Зовнішні команди

/** Запускає команду поза потоком інтерфейсу. stdin — /dev/null, якщо не передано input. */
function run(file, args, { env = {}, input } = {}) {
  return new Promise(resolve => {
    let output = ''
    let p
    try {
      p = spawn(file, args, {
        env: { ...process.env, ...env },
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      resolve({ code: -1, output: `Не вдалося запустити ${file}: ${e.message}` })
      return
    }
    p.stdout.on('data', d => (output += d))
    p.stderr.on('data', d => (output += d))
    p.on('error', e => resolve({ code: -1, output: `Не вдалося запустити ${file}: ${e.message}` }))
    p.on('close', code => resolve({ code: code ?? -1, output }))
    if (input !== undefined) p.stdin.end(input)
  })
}

/** GUI-застосунок не успадковує PATH оболонки, тому теки перелічено явно. Системні — першими. */
function toolDirs() {
  if (IS_MAC) return ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']
  if (IS_WIN) {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH')
    return [sys, ...(process.env.PATH || '').split(';').filter(Boolean)]
  }
  return ['/usr/bin', '/usr/local/bin']
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function findTool(name, dirs = toolDirs()) {
  return dirs.map(d => path.join(d, name + EXE)).find(isExecutable) || null
}

/** На Windows ssh-copy-id немає — його відтворюємо через ssh. */
function requiredTools(mode) {
  if (mode !== 'full') return ['ssh-keygen']
  return IS_WIN ? ['ssh-keygen', 'ssh', 'ssh-add'] : ['ssh-keygen', 'ssh-copy-id', 'ssh', 'ssh-add']
}

function resolveTools(mode) {
  if (!requiredTools(mode).every(n => findTool(n))) return null
  const f = n => findTool(n) || ''
  return { keygen: f('ssh-keygen'), copyId: f('ssh-copy-id'), ssh: f('ssh'), add: f('ssh-add') }
}

/** Тимчасовий скрипт SSH_ASKPASS: віддає секрет зі змінної оточення, сам секрету не містить. */
function makeAskpass() {
  const id = crypto.randomUUID()
  const file = IS_WIN
    ? path.join(os.tmpdir(), `sshkm-askpass-${id}.cmd`)
    : path.join(os.tmpdir(), `sshkm-askpass-${id}.sh`)
  const body = IS_WIN ? '@echo %SSHKM_SECRET%\r\n' : '#!/bin/sh\nprintf \'%s\\n\' "$SSHKM_SECRET"\n'
  fs.writeFileSync(file, body, { mode: 0o700 })
  return file
}

async function ask(title, text, ok) {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    message: title,
    detail: text,
    buttons: [ok, 'Скасувати'],
    defaultId: 0,
    cancelId: 1,
  })
  return r.response === 0
}

// MARK: - Встановлення бракуючого OpenSSH (лише за згодою)

/** Повертає true, якщо після встановлення можна продовжувати. */
async function installOpenSSH(missing, say) {
  const list = missing.join(', ')

  if (IS_MAC) {
    const brew = findTool('brew', ['/opt/homebrew/bin', '/usr/local/bin'])
    if (!brew) {
      if (await ask('Немає Homebrew',
        `Для встановлення ${list} потрібен менеджер пакетів Homebrew. Відкрити Термінал із командою його встановлення? Після встановлення натисніть «Згенерувати» ще раз.`,
        'Відкрити Термінал')) {
        const cmd = '/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\"'
        await run('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${cmd}"`,
          '-e', 'tell application "Terminal" to activate'])
        say('✗ Встановіть Homebrew у Терміналі й повторіть.')
      } else {
        say(`✗ Без ${list} продовжити не можу.`)
      }
      return false
    }
    if (!await ask('Встановити OpenSSH?',
      `Бракує команд: ${list}. Встановити пакет openssh через Homebrew (brew install openssh)?`, 'Встановити')) {
      say('✗ Встановлення скасовано.')
      return false
    }
    say('→ brew install openssh… (може тривати кілька хвилин)')
    return reportInstall(await run(brew, ['install', 'openssh'], { env: { NONINTERACTIVE: '1' } }), say)
  }

  if (IS_WIN) {
    if (!await ask('Встановити OpenSSH?',
      `Бракує команд: ${list}. Встановити компонент Windows «OpenSSH Client»? Windows попросить підтвердити права адміністратора.`,
      'Встановити')) {
      say('✗ Встановлення скасовано.')
      return false
    }
    say('→ Add-WindowsCapability OpenSSH.Client… (може тривати кілька хвилин)')
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const inner = 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'
    const script = `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-Command','${inner}'; exit $p.ExitCode`
    return reportInstall(await run(ps, ['-NoProfile', '-Command', script]), say)
  }

  // Linux: менеджер пакетів через pkexec (графічний запит пароля)
  const managers = [
    ['apt-get', ['install', '-y', 'openssh-client']],
    ['dnf', ['install', '-y', 'openssh-clients']],
    ['pacman', ['-S', '--noconfirm', 'openssh']],
    ['zypper', ['--non-interactive', 'install', 'openssh-clients']],
  ]
  const found = managers.map(([n, a]) => [findTool(n, ['/usr/bin', '/bin', '/usr/sbin']), n, a]).find(([p]) => p)
  if (!found) {
    say(`✗ Не знайдено менеджера пакетів. Встановіть OpenSSH-клієнт (${list}) вручну й повторіть.`)
    return false
  }
  const [pm, pmName, pmArgs] = found
  const pkexec = findTool('pkexec', ['/usr/bin', '/bin'])
  if (!pkexec) {
    say(`✗ Немає pkexec. Виконайте в терміналі: sudo ${pmName} ${pmArgs.join(' ')}`)
    return false
  }
  if (!await ask('Встановити OpenSSH?',
    `Бракує команд: ${list}. Встановити пакет (${pmName} ${pmArgs.join(' ')})? Система попросить пароль адміністратора.`,
    'Встановити')) {
    say('✗ Встановлення скасовано.')
    return false
  }
  say(`→ ${pmName} ${pmArgs.join(' ')}… (може тривати кілька хвилин)`)
  return reportInstall(await run(pkexec, [pm, ...pmArgs]), say)
}

function reportInstall(r, say) {
  if (r.output.trim()) say(r.output.trim())
  if (r.code !== 0) {
    say(`✗ Встановлення не вдалося (код ${r.code}).`)
    return false
  }
  say('✓ OpenSSH встановлено.')
  return true
}

// MARK: - Алгоритм

function validate(f) {
  if (!/^[A-Za-z0-9._-]+$/.test(f.name)) return 'Назва: лише латиниця, цифри, крапка, дефіс, підкреслення.'
  if (f.mode !== 'full') return null
  if (!f.host || /\s/.test(f.host)) return 'Вкажіть хост без пробілів.'
  const p = Number(f.port)
  if (!/^\d+$/.test(f.port) || p < 1 || p > 65535) return 'Порт — число від 1 до 65535.'
  if (!f.user || /\s/.test(f.user)) return 'Вкажіть користувача на сервері.'
  if (!f.serverPassword) return 'Потрібен пароль від сервера — щоб залити ключ.'
  return null
}

const keyDirFor = mode => (mode === 'files' ? PROJECT_KEYS_DIR : SSH_DIR)

async function generate(f, say, showKey) {
  f = { ...f, name: f.name.trim(), host: f.host.trim(), user: f.user.trim(), port: f.port.trim() }
  const err = validate(f)
  if (err) { say(`✗ ${err}`); return false }

  // 1. Залежності
  let tools = resolveTools(f.mode)
  if (!tools) {
    const missing = requiredTools(f.mode).filter(n => !findTool(n))
    say(`⚠︎ Не знайдено: ${missing.join(', ')}`)
    if (!await installOpenSSH(missing, say)) return false
    tools = resolveTools(f.mode)
    if (!tools) { say('✗ Після встановлення команд усе одно не знайдено.'); return false }
  }

  const { mode, name, host, port, user, serverPassword, passphrase } = f
  const keyDir = keyDirFor(mode)
  const key = path.join(keyDir, `id_ed25519_${name}`)
  const pub = key + '.pub'
  const config = path.join(SSH_DIR, 'config')

  // 2. Тека ключів
  try {
    if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 })
    // Тека keys у проєкті: щоб приватні ключі не потрапили в git
    const ignore = path.join(keyDir, '.gitignore')
    if (mode === 'files' && !fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
  } catch (e) {
    say(`✗ Не вдалося створити ${keyDir}: ${e.message}`)
    return false
  }

  // 3. Нічого не перезаписуємо
  if (fs.existsSync(key) || fs.existsSync(pub)) {
    say(`✗ Ключ ${key} уже існує. Оберіть іншу назву — наявний ключ не перезаписую.`)
    return false
  }
  let existing = ''
  try { existing = fs.readFileSync(config, 'utf8') } catch {}
  const hostTaken = existing.split(/\r?\n/).some(line => {
    const parts = line.trim().split(/[ \t]+/)
    return parts[0].toLowerCase() === 'host' && parts.slice(1).includes(name)
  })
  if (mode === 'full' && hostTaken) {
    say(`✗ У ~/.ssh/config уже є запис Host ${name}. Оберіть іншу назву.`)
    return false
  }

  // 4. Ключ
  say(`→ Створюю ключ ${key}…`)
  const comment = mode === 'full' ? `${user}@${name}` : name
  const gen = await run(tools.keygen, ['-t', 'ed25519', '-f', key, '-N', passphrase, '-C', comment])
  if (gen.code !== 0) { say(`✗ ssh-keygen:\n${gen.output}`); return false }
  let pubText = ''
  try { pubText = fs.readFileSync(pub, 'utf8').trim() } catch {}
  showKey(pubText, key)
  say('✓ Ключ створено.')
  if (mode !== 'full') {
    say(`✓ Готово. Приватний: ${key}\n  Публічний: ${pub}`)
    return true
  }

  // 5. Запис у кінець config (з резервною копією)
  try {
    if (fs.existsSync(config)) {
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
      const backup = path.join(SSH_DIR, `config.bak-${stamp}`)
      fs.copyFileSync(config, backup, fs.constants.COPYFILE_EXCL)
      say(`✓ Резервна копія конфігу: ${backup}`)
    }
    let block = existing === '' || existing.endsWith('\n') ? '' : '\n'
    if (existing !== '') block += '\n'
    const lines = [
      `Host ${name}`,
      `    HostName ${host}`,
      `    Port ${port}`,
      `    User ${user}`,
      `    IdentityFile ~/.ssh/id_ed25519_${name}`,
      '    IdentitiesOnly yes',
      '    AddKeysToAgent yes',
    ]
    // UseKeychain — лише macOS; IgnoreUnknown рятує ssh, зібраний не Apple
    if (IS_MAC) lines.push('    IgnoreUnknown UseKeychain', '    UseKeychain yes')
    block += lines.join('\n') + '\n'
    fs.writeFileSync(config, existing + block, { mode: 0o600 })
    if (IS_WIN) {
      const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
      const r = await run(icacls, [config, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`])
      if (r.code !== 0) say(`⚠︎ icacls:\n${r.output.trim()}`)
    } else {
      fs.chmodSync(config, 0o600)
    }
    say(`✓ Додано Host ${name} у кінець ~/.ssh/config.`)
  } catch (e) {
    say(`✗ Не вдалося записати config: ${e.message}`)
    return false
  }

  let askpass
  try { askpass = makeAskpass() } catch (e) {
    say(`✗ Не вдалося підготувати askpass: ${e.message}`)
    return false
  }
  const askEnv = { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' }

  try {
    // 6. Ключ із паролем — в агент до заливання, щоб ssh-copy-id не спитав passphrase через askpass
    if (passphrase) {
      say('→ Додаю ключ в агент…')
      const args = tools.add === '/usr/bin/ssh-add' && IS_MAC ? ['--apple-use-keychain', key] : [key]
      const add = await run(tools.add, args, { env: { ...askEnv, SSHKM_SECRET: passphrase } })
      if (add.code === 0) say('✓ Ключ в агенті.')
      else say(`⚠︎ ssh-add:\n${add.output.trim()}` +
        (IS_WIN ? '\n  Можливо, не запущено службу ssh-agent (Set-Service ssh-agent -StartupType Automatic).' : ''))
    }

    // 7. Залити ключ на сервер
    say(`→ Заливаю ключ на ${user}@${host}:${port}…`)
    const opts = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
      '-o', 'PreferredAuthentications=publickey,password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1']
    const copyEnv = { ...askEnv, SSHKM_SECRET: serverPassword }
    let copy
    if (IS_WIN) {
      // ssh-copy-id немає: ключ іде через stdin у authorized_keys (сервер — Unix)
      const remote = 'umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
      copy = await run(tools.ssh, ['-p', port, ...opts, `${user}@${host}`, remote], { env: copyEnv, input: pubText + '\n' })
    } else {
      // ssh-copy-id — shell-скрипт, що кличе ssh з PATH: підкладаємо теку обраного ssh першою
      copyEnv.PATH = `${path.dirname(tools.ssh)}:/usr/bin:/bin:/usr/sbin:/sbin`
      copy = await run(tools.copyId, ['-i', pub, '-p', port, ...opts, `${user}@${host}`], { env: copyEnv })
    }
    if (copy.output.trim()) say(copy.output.trim())
    if (copy.code !== 0) {
      say(`✗ ${IS_WIN ? 'Заливання' : 'ssh-copy-id'} завершилось з кодом ${copy.code}.`)
      return false
    }
    say('✓ Ключ на сервері.')
  } finally {
    try { fs.rmSync(askpass, { force: true }) } catch {}
  }

  // 8. Перевірка: вхід лише за ключем, через новий запис конфігу
  say(`→ Перевіряю вхід: ssh ${name}…`)
  const test = await run(tools.ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=accept-new', name, 'echo SSHKM_OK'])
  if (test.code === 0 && test.output.includes('SSHKM_OK')) {
    say(`✓ Вхід за ключем працює. Далі: ssh ${name}`)
    return true
  }
  say(`✗ Вхід за ключем не вдався:\n${test.output}`)
  return false
}

// MARK: - Вікно

ipcMain.handle('paths', () => ({ sshDir: SSH_DIR, keysDir: PROJECT_KEYS_DIR, platform: process.platform }))
ipcMain.handle('generate', (e, form) =>
  generate(form,
    line => e.sender.send('log', line),
    (key, keyPath) => e.sender.send('key', { key, keyPath })))
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p))
ipcMain.handle('copy', (_e, text) => clipboard.writeText(text))

app.whenReady().then(() => {
  if (IS_MAC && fs.existsSync(ICON)) app.dock.setIcon(ICON)
  win = new BrowserWindow({
    title: 'SSH Key Maker',
    width: 620,
    height: 720,
    minWidth: 560,
    minHeight: 620,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
})

app.on('window-all-closed', () => app.quit())
