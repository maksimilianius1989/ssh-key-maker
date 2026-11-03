const $ = id => document.getElementById(id)
const api = window.sshkm

const LAMP_TEXT = { idle: 'Очікує', working: 'Виконується…', ok: "З'єднання працює", fail: 'Помилка' }
// Блоки кроків; головний процес повідомляє подією step, який почався. Ключові режими — лише перші три
const STEPS = [
  { id: 'check', label: 'Поля', doing: 'Перевіряю поля' },
  { id: 'tools', label: 'OpenSSH', doing: 'Шукаю OpenSSH' },
  { id: 'key', label: 'Ключ', doing: 'Створюю ключ' },
  { id: 'config', label: 'Конфіг', doing: 'Оновлюю конфіг' },
  { id: 'upload', label: 'Заливання', doing: 'Заливаю ключ на сервер' },
  { id: 'test', label: 'Вхід', doing: 'Перевіряю вхід за ключем' },
  { id: 'cleanup', label: 'Старий ключ', doing: 'Прибираю старий ключ' },
]
let paths = { sshDir: '~/.ssh', keysDir: 'keys', platform: '' }
let keyPath = null
let publicKey = ''

const mode = () => document.querySelector('input[name=mode]:checked').value
const visibleSteps = () => (mode() === 'full' ? STEPS : STEPS.slice(0, 3))

function setLamp(state) {
  $('lamp').className = 'lamp' + (state === 'idle' ? '' : ' ' + state)
  $('state').textContent = state === 'ok' && mode() !== 'full' ? 'Ключі створено' : LAMP_TEXT[state]
}

function setBusy(busy) {
  $('fields').disabled = busy
  $('go').disabled = busy
  document.body.classList.toggle('busy', busy)
}

function renderSteps() {
  $('steps').replaceChildren(...visibleSteps().map((s, i) => {
    const el = document.createElement('div')
    el.className = 'step'
    el.dataset.id = s.id
    const dot = document.createElement('div')
    dot.className = 'dot'
    dot.textContent = i + 1
    const label = document.createElement('span')
    label.textContent = s.label
    el.append(dot, label)
    return el
  }))
}

function setStep(el, state) {
  el.className = 'step ' + state
  const i = [...el.parentNode.children].indexOf(el)
  el.firstChild.textContent = state === 'done' ? '✓' : state === 'fail' ? '✗' : state === 'skipped' ? '–' : i + 1
}

function startStep(id) {
  const steps = [...$('steps').children]
  steps.filter(el => el.classList.contains('active')).forEach(el => setStep(el, 'done'))
  const el = steps.find(el => el.dataset.id === id)
  if (!el) return
  setStep(el, 'active')
  const s = STEPS.find(s => s.id === id)
  $('state').textContent = `${s.doing}…`
}

function finishSteps(ok) {
  for (const el of $('steps').children) {
    if (el.classList.contains('active')) setStep(el, ok ? 'done' : 'fail')
    else if (ok && !el.classList.contains('done')) setStep(el, 'skipped')
  }
}

function append(line) {
  const log = $('log')
  const row = document.createElement('div')
  row.textContent = line.replace(/\n$/, '')
  const kind = { '→': 'step-line', '✓': 'ok', '⚠': 'warn', '✗': 'fail' }[line.trimStart()[0]]
  if (kind) row.className = kind
  log.append(row)
  log.scrollTop = log.scrollHeight
}

function updateMode() {
  const full = mode() === 'full'
  document.querySelectorAll('.full').forEach(el => el.classList.toggle('hidden', !full))
  $('name-label').textContent = full ? 'Назва (Host у конфігу):' : 'Назва ключа:'
  const dir = mode() === 'files' ? paths.keysDir : paths.sshDir
  $('where').textContent = full ? `${dir} + config + сервер` : dir
  if (paths.platform === 'darwin') $('reveal').textContent = 'Показати у Finder'
  renderSteps()
}

function showKey(key, path) {
  publicKey = key
  keyPath = path
  const pre = $('pubkey')
  pre.textContent = key || '—'
  pre.classList.remove('fresh')
  if (key) { void pre.offsetWidth; pre.classList.add('fresh') }
  $('copy').disabled = !key
  $('reveal').disabled = !path
}

document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', updateMode))

$('form').addEventListener('submit', async e => {
  e.preventDefault()
  if ($('go').disabled) return
  $('log').replaceChildren()
  showKey('', null)
  renderSteps()
  setBusy(true)
  setLamp('working')
  const form = {
    mode: mode(),
    name: $('name').value,
    host: $('host').value,
    port: $('port').value,
    user: $('user').value,
    serverPassword: $('serverPassword').value,
    passphrase: $('passphrase').value,
  }
  let ok = false
  try {
    ok = await api.generate(form)
  } catch (err) {
    append(`✗ ${err.message}`)
  }
  finishSteps(ok)
  setLamp(ok ? 'ok' : 'fail')
  setBusy(false)
  $('serverPassword').value = ''
})

$('copy').addEventListener('click', async () => {
  await api.copy(publicKey)
  const b = $('copy')
  b.textContent = 'Скопійовано ✓'
  setTimeout(() => { b.textContent = 'Копіювати' }, 1400)
})
$('reveal').addEventListener('click', () => keyPath && api.reveal(keyPath))
$('repo').addEventListener('click', e => {
  e.preventDefault()
  api.openRepo()
})

api.onLog(append)
api.onKey(({ key, keyPath }) => showKey(key, keyPath))
api.onStep(startStep)

api.paths().then(p => {
  paths = p
  $('repo').title = p.repoUrl
  updateMode()
})
updateMode()
