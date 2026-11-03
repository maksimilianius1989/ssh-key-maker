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
const REPO_URL = 'https://github.com/maksimilianius1989/ssh-key-maker'

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
  return { keygen: f('ssh-keygen'), copyId: f('ssh-copy-id'), ssh: f('ssh'), add: f('ssh-add'), keyscan: f('ssh-keyscan') }
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

// MARK: - Змінений відбиток сервера

/**
 * Якщо ssh відмовив через змінений відбиток сервера — показує старий і новий відбитки й за згодою
 * замінює запис у known_hosts. Новий ключ сервера береться через ssh-keyscan і записується, лише якщо
 * його відбиток збігається з тим, що показано людині. Повертає true, якщо можна пробувати ще раз.
 */
async function acceptChangedHostKey(output, tools, host, port, say) {
  if (!/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(output)) return false
  const m = output.match(/fingerprint for the (\S+) key sent by the remote host is\s*(?:ERROR:\s*)?(SHA256:[A-Za-z0-9+/=]+)/)
  if (!m || !tools.keyscan) {
    say('✗ Відбиток сервера змінився, а прийняти новий автоматично не вдається.')
    return false
  }
  const [, type, newFp] = m
  const spec = port === '22' ? host : `[${host}]:${port}`
  const known = await run(tools.keygen, ['-lF', spec])
  const oldFps = [...new Set(known.output.match(/SHA256:[A-Za-z0-9+/=]+/g) || [])]

  const accept = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'Відбиток сервера змінився',
    detail: `Сервер ${spec} надіслав не той відбиток, що запам'ятовано раніше. Так буває, коли сервер ` +
      'перевстановили або змінили йому ключ. Але це може бути й перехоплення з\'єднання — приймайте новий ' +
      'відбиток, лише якщо впевнені (наприклад, звірили з адміністратором).\n\n' +
      `Було: ${oldFps.join(', ') || 'невідомо'}\nЗараз (${type}): ${newFp}`,
    buttons: ['Сервер змінено — прийняти новий', 'Скасувати'],
    defaultId: 1,
    cancelId: 1,
  })
  if (accept.response !== 0) {
    say('✗ Новий відбиток сервера не прийнято.')
    return false
  }

  say(`→ Отримую ключ сервера ${spec}…`)
  const scan = await run(tools.keyscan, ['-p', port, '-T', '15', '-t', type.toLowerCase(), host])
  let line = null
  for (const l of scan.output.split(/\r?\n/).filter(l => l && !l.startsWith('#'))) {
    const fp = await run(tools.keygen, ['-lf', '-'], { input: l + '\n' })
    if (fp.code === 0 && fp.output.split(/\s+/)[1] === newFp) { line = l; break }
  }
  if (!line) {
    say(`✗ Сервер віддав ключ з іншим відбитком, ніж ${newFp}. Нічого не змінюю.`)
    return false
  }
  // ssh-keygen -R сам лишає копію known_hosts.old
  const rm = await run(tools.keygen, ['-R', spec])
  if (rm.code !== 0) { say(`✗ ssh-keygen -R:\n${rm.output.trim()}`); return false }
  try {
    fs.appendFileSync(path.join(SSH_DIR, 'known_hosts'), line + '\n', { mode: 0o600 })
  } catch (e) {
    say(`✗ Не вдалося записати known_hosts: ${e.message}`)
    return false
  }
  say(`✓ Новий відбиток сервера прийнято (${newFp}). Стару копію — у known_hosts.old.`)
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

/** Рядок `Host`, серед шаблонів якого точно є name. */
function isHostLine(line, name) {
  const parts = line.trim().split(/[ \t]+/)
  return parts[0].toLowerCase() === 'host' && parts.slice(1).includes(name)
}

/** Що ssh насправді візьме для name (`ssh -G`): хост, порт, користувач, ключі абсолютними шляхами; null — не спрацював. */
async function hostSettings(ssh, name) {
  const g = await run(ssh, ['-G', name])
  if (g.code !== 0) return null
  const r = { hostname: '', port: '', user: '', ids: [] }
  for (const l of g.output.split(/\r?\n/)) {
    const m = l.match(/^(\S+) (.*)$/)
    if (!m) continue
    const k = m[1].toLowerCase(), v = m[2].trim()
    if (k === 'identityfile') r.ids.push(path.resolve(v.replace(/^~(?=$|[\\/])/, os.homedir())))
    else if (k in r) r[k] = v
  }
  return r
}

/** Поля запису Host name, які треба змінити, щоб він відповідав формі (порожньо — нічого). */
function hostChanges(cur, { host, port, user }, key, name) {
  const c = {}
  if (cur.hostname.toLowerCase() !== host.toLowerCase()) c.HostName = [cur.hostname, host]
  if (cur.port !== String(Number(port))) c.Port = [cur.port, port]
  if (cur.user !== user) c.User = [cur.user, user]
  if (!cur.ids.includes(path.resolve(key))) c.IdentityFile = [cur.ids.join(', '), `~/.ssh/id_ed25519_${name}`]
  return c
}

/**
 * Правка першого запису Host name на місці: кожне поле з fields — один рядок замість наявних
 * (там, де стояв перший; немає — одразу після Host), решта рядків як були. null — запису в тексті немає.
 */
function updateHostBlock(text, name, fields) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => isHostLine(l, name))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && /^\s*(host|match)\b/i.test(l))
  if (end < 0) end = lines.length
  let body = lines.slice(start + 1, end)
  const indent = (body.find(l => /^\s+\S/.test(l)) || '').match(/^\s*/)[0] || '    '
  let added = 0
  for (const [k, v] of Object.entries(fields)) {
    const re = new RegExp(`^\\s*${k}(\\s|=)`, 'i')
    const first = body.findIndex(l => re.test(l))
    body = body.filter(l => !re.test(l))
    body.splice(first >= 0 ? first : added++, 0, `${indent}${k} ${v}`)
  }
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join(eol)
}

/** Якщо оновлення зірвалось до заливання на сервер — новий ключ ніде не використано, повертаємо старий. */
async function generate(f, say, showKey, step) {
  const state = { rollback: null }
  let ok = false
  try {
    ok = await generateSteps(f, say, showKey, step, state)
  } finally {
    if (!ok && state.rollback) state.rollback()
  }
  return ok
}

/** step(id) — у вікні починається блок кроку: check, tools, key, config, upload, test, cleanup. */
async function generateSteps(f, say, showKey, step, state) {
  step('check')
  f = { ...f, name: f.name.trim(), host: f.host.trim(), user: f.user.trim(), port: f.port.trim() }
  const err = validate(f)
  if (err) { say(`✗ ${err}`); return false }

  // 1. Залежності
  step('tools')
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
  step('key')
  try {
    if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 })
    // Тека keys у проєкті: щоб приватні ключі не потрапили в git
    const ignore = path.join(keyDir, '.gitignore')
    if (mode === 'files' && !fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
  } catch (e) {
    say(`✗ Не вдалося створити ${keyDir}: ${e.message}`)
    return false
  }

  // 3. Наявний ключ чи запис Host — оновлюємо лише за згодою; старий ключ лишається резервною копією
  const keyTaken = fs.existsSync(key) || fs.existsSync(pub)
  let existing = ''
  try { existing = fs.readFileSync(config, 'utf8') } catch {}
  const hostTaken = mode === 'full' && existing.split(/\r?\n/).some(line => isHostLine(line, name))
  // Наявний Host лишається на своєму місці; змінюємо (крок 5) лише поля, що не збігаються з формою
  let changes = {}
  if (hostTaken) {
    const cur = await hostSettings(tools.ssh, name)
    if (!cur) { say(`✗ ssh -G ${name} не зміг прочитати ~/.ssh/config — перевірте його.`); return false }
    changes = hostChanges(cur, f, key, name)
  }
  const changeList = Object.entries(changes).map(([k, [a, b]]) => `${k}: ${a || '—'} → ${b}`)
  let oldPubText = ''
  if (keyTaken || hostTaken) {
    const found = [keyTaken && `ключ ${key}`, hostTaken && `запис Host ${name} у ~/.ssh/config`].filter(Boolean)
    const detail = `Уже є ${found.join(' і ')}. Створити новий ключ замість старого?` +
      (keyTaken ? ' Старий ключ буде збережено як резервну копію' + (mode === 'full' ? ' і прибрано з сервера.' : '.') : '') +
      (changeList.length ? `\n\nУ записі Host (на тому ж місці, з резервною копією конфігу) буде змінено:\n${changeList.join('\n')}`
        : hostTaken ? ' Запис Host уже відповідає формі й не змінюється.' : '')
    if (!await ask('Оновити ключ?', detail, 'Оновити')) {
      say('✗ Скасовано — наявний ключ не змінено.')
      return false
    }
    if (keyTaken) {
      try { oldPubText = fs.readFileSync(pub, 'utf8').trim() } catch {}
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
      try {
        for (const f of [key, pub]) if (fs.existsSync(f)) fs.renameSync(f, `${f}.bak-${stamp}`)
      } catch (e) {
        say(`✗ Не вдалося відкласти старий ключ: ${e.message}`)
        return false
      }
      say(`✓ Старий ключ збережено як ${key}.bak-${stamp}`)
      state.rollback = () => {
        try {
          for (const f of [key, pub]) fs.rmSync(f, { force: true })
          for (const f of [key, pub]) if (fs.existsSync(`${f}.bak-${stamp}`)) fs.renameSync(`${f}.bak-${stamp}`, f)
          say(`⚠︎ Старий ключ повернуто на місце: ${key}`)
        } catch (e) {
          say(`⚠︎ Не вдалося повернути старий ключ (${e.message}). Він лежить у ${key}.bak-${stamp}`)
        }
      }
    }
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

  step('config')
  // 5. Конфіг (з резервною копією): новий запис — у кінець; наявний правимо на місці, лише поля, що відрізняються
  let updated = null
  if (changeList.length) {
    updated = updateHostBlock(existing, name, Object.fromEntries(Object.entries(changes).map(([k, [, v]]) => [k, v])))
    if (updated === null) {
      say(`✗ Запис Host ${name} не в самому ~/.ssh/config (мабуть, в Include) — виправте його вручну:\n  ${changeList.join('\n  ')}`)
      return false
    }
  } else if (hostTaken) {
    say(`✓ Запис Host ${name} уже є в ~/.ssh/config і відповідає формі — конфіг не змінюю.`)
  } else {
    let block = existing === '' || existing.endsWith('\n') ? '' : '\n'
    if (existing !== '') block += '\n'
    const lines = [
      `Host ${name}`,
      `    HostName ${host}`,
      `    Port ${port}`,
      `    User ${user}`,
      `    IdentityFile ~/.ssh/id_ed25519_${name}`,
      '    IdentitiesOnly yes',
    ]
    // UseKeychain — лише macOS; IgnoreUnknown рятує ssh, зібраний не Apple
    if (IS_MAC) lines.push('    IgnoreUnknown UseKeychain', '    UseKeychain yes')
    updated = existing + block + lines.join('\n') + '\n'
  }
  if (updated !== null) try {
    if (fs.existsSync(config)) {
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
      const backup = path.join(SSH_DIR, `config.bak-${stamp}`)
      fs.copyFileSync(config, backup, fs.constants.COPYFILE_EXCL)
      say(`✓ Резервна копія конфігу: ${backup}`)
    }
    fs.writeFileSync(config, updated, { mode: 0o600 })
    if (IS_WIN) {
      const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
      const r = await run(icacls, [config, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`])
      if (r.code !== 0) say(`⚠︎ icacls:\n${r.output.trim()}`)
    } else {
      fs.chmodSync(config, 0o600)
    }
    say(changeList.length ? `✓ У записі Host ${name} змінено:\n  ${changeList.join('\n  ')}`
      : `✓ Додано Host ${name} у кінець ~/.ssh/config.`)
  } catch (e) {
    say(`✗ Не вдалося записати config: ${e.message}`)
    return false
  }
  if (changeList.length) {
    const cur = await hostSettings(tools.ssh, name)
    const left = cur ? Object.keys(hostChanges(cur, f, key, name)) : ['усе']
    if (left.length) {
      say(`✗ Після правки ssh -G ${name} усе одно не збігається з формою (${left.join(', ')}) — ` +
        'мабуть, ці поля задає запис вище в ~/.ssh/config. Перевірте його.')
      return false
    }
  }

  step('upload')
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
    const upload = () => {
      if (IS_WIN) {
        // ssh-copy-id немає: ключ іде через stdin у authorized_keys (сервер — Unix)
        const remote = 'umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
        return run(tools.ssh, ['-p', port, ...opts, `${user}@${host}`, remote], { env: copyEnv, input: pubText + '\n' })
      }
      // ssh-copy-id — shell-скрипт, що кличе ssh з PATH: підкладаємо теку обраного ssh першою
      copyEnv.PATH = `${path.dirname(tools.ssh)}:/usr/bin:/bin:/usr/sbin:/sbin`
      return run(tools.copyId, ['-i', pub, '-p', port, ...opts, `${user}@${host}`], { env: copyEnv })
    }
    let copy = await upload()
    if (copy.output.trim()) say(copy.output.trim())
    // Відбиток сервера змінився — за згодою запам'ятати новий і спробувати ще раз
    if (copy.code !== 0 && await acceptChangedHostKey(copy.output, tools, host, port, say)) {
      say(`→ Заливаю ключ на ${user}@${host}:${port} ще раз…`)
      copy = await upload()
      if (copy.output.trim()) say(copy.output.trim())
    }
    if (copy.code !== 0) {
      say(`✗ ${IS_WIN ? 'Заливання' : 'ssh-copy-id'} завершилось з кодом ${copy.code}.`)
      return false
    }
    say('✓ Ключ на сервері.')
    // Новий ключ уже на сервері — далі старий не повертаємо, навіть якщо перевірка не пройде
    state.rollback = null
  } finally {
    try { fs.rmSync(askpass, { force: true }) } catch {}
  }

  step('test')
  // 8. Перевірка: вхід лише за ключем, через новий запис конфігу
  say(`→ Перевіряю вхід: ssh ${name}…`)
  const test = await run(tools.ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=accept-new', name, 'echo SSHKM_OK'])
  if (!(test.code === 0 && test.output.includes('SSHKM_OK'))) {
    say(`✗ Вхід за ключем не вдався:\n${test.output}`)
    return false
  }
  say('✓ Вхід за ключем працює.')

  // 9. Старий ключ — геть із authorized_keys, уже входячи новим (так доступ не губиться)
  if (keyTaken) {
    step('cleanup')
    const blob = oldPubText.split(/\s+/).slice(0, 2).join(' ')
    if (!/^\S+ \S+$/.test(blob) || blob === pubText.split(/\s+/).slice(0, 2).join(' ')) {
      say('⚠︎ Старого публічного ключа немає — приберіть його з ~/.ssh/authorized_keys на сервері вручну.')
    } else {
      say('→ Прибираю старий ключ із сервера…')
      // Ключ — у stdin; порожній рядок відкидаємо, бо grep -vF "" стер би весь файл
      const remote = 'k=$(cat); f=~/.ssh/authorized_keys; [ -n "$k" ] || exit 1; [ -f "$f" ] || exit 0; ' +
        '{ grep -vF -- "$k" "$f" || true; } > "$f.sshkm" && cat "$f.sshkm" > "$f" && rm -f "$f.sshkm"'
      const rm = await run(tools.ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
        '-o', 'StrictHostKeyChecking=accept-new', name, remote], { input: blob + '\n' })
      if (rm.code === 0) say('✓ Старий ключ прибрано з сервера.')
      else say(`⚠︎ Не вдалося прибрати старий ключ із сервера:\n${rm.output.trim()}`)
    }
  }

  say(`✓ Готово. Далі: ssh ${name}`)
  return true
}

// MARK: - Вікно

ipcMain.handle('paths', () => ({ sshDir: SSH_DIR, keysDir: PROJECT_KEYS_DIR, platform: process.platform, repoUrl: REPO_URL }))
ipcMain.handle('generate', (e, form) =>
  generate(form,
    line => e.sender.send('log', line),
    (key, keyPath) => e.sender.send('key', { key, keyPath }),
    id => e.sender.send('step', id)))
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p))
ipcMain.handle('copy', (_e, text) => clipboard.writeText(text))
// Лише адреса репозиторію з головного процесу — довільних URL вікно відкрити не може
ipcMain.handle('openRepo', () => shell.openExternal(REPO_URL))

app.whenReady().then(() => {
  if (IS_MAC && fs.existsSync(ICON)) app.dock.setIcon(ICON)
  win = new BrowserWindow({
    title: 'SSH Key Maker',
    width: 620,
    height: 860,
    minWidth: 560,
    minHeight: 760,
    backgroundColor: '#080b17',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // Вікно нікуди не переходить і нових вікон не відкриває — посилання йдуть у системний браузер
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile(path.join(__dirname, 'index.html'))
})

app.on('window-all-closed', () => app.quit())
