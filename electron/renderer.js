const $ = id => document.getElementById(id)
const api = window.sshkm

const LAMP_TEXT = { idle: 'Очікує', working: 'Виконується…', ok: "З'єднання працює", fail: 'Помилка' }
let paths = { sshDir: '~/.ssh', keysDir: 'keys', platform: '' }
let keyPath = null
let publicKey = ''

const mode = () => document.querySelector('input[name=mode]:checked').value

function setLamp(state) {
  $('lamp').className = 'lamp' + (state === 'idle' ? '' : ' ' + state)
  $('state').textContent = state === 'ok' && mode() !== 'full' ? 'Ключі створено' : LAMP_TEXT[state]
}

function setBusy(busy) {
  $('fields').disabled = busy
  $('go').disabled = busy
  $('spinner').classList.toggle('hidden', !busy)
}

function append(line) {
  const log = $('log')
  log.textContent += line.endsWith('\n') ? line : line + '\n'
  log.scrollTop = log.scrollHeight
}

function updateMode() {
  const full = mode() === 'full'
  document.querySelectorAll('.full').forEach(el => el.classList.toggle('hidden', !full))
  $('name-label').textContent = full ? 'Назва (Host у конфігу):' : 'Назва ключа:'
  const dir = mode() === 'files' ? paths.keysDir : paths.sshDir
  $('where').textContent = full ? `${dir} + config + сервер` : dir
  if (paths.platform === 'darwin') $('reveal').textContent = 'Показати у Finder'
}

function showKey(key, path) {
  publicKey = key
  keyPath = path
  $('pubkey').textContent = key || '—'
  $('copy').disabled = !key
  $('reveal').disabled = !path
}

document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', updateMode))

$('form').addEventListener('submit', async e => {
  e.preventDefault()
  if ($('go').disabled) return
  $('log').textContent = ''
  showKey('', null)
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
  setLamp(ok ? 'ok' : 'fail')
  setBusy(false)
  $('serverPassword').value = ''
})

$('copy').addEventListener('click', () => api.copy(publicKey))
$('reveal').addEventListener('click', () => keyPath && api.reveal(keyPath))

api.onLog(append)
api.onKey(({ key, keyPath }) => showKey(key, keyPath))

api.paths().then(p => {
  paths = p
  updateMode()
})
updateMode()
