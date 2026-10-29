# SSH Key Maker — специфікація для AI-агента

Цей документ — **джерело правди** про програму. За ним агент має змогу відтворити її на будь-якій
ОС (macOS, Windows, Linux) і будь-якою мовою чи фреймворком. Реалізація — кросплатформна,
на Electron (`electron/`). Інструкція для людини — `README.md`.

## Тип програми

- **Десктопний GUI-застосунок на одне вікно** (не веб-сервіс, не CLI). Реалізовано на Electron;
  нативна реалізація має повторювати той самий інтерфейс і поведінку.
- Офлайн-утиліта для одного користувача. Працює з правами поточного користувача, без адмінських прав.
- Не зберігає налаштувань і секретів. Стан живе лише, поки відкрите вікно.
- Сама нічого не шифрує. Уся криптографія та мережа — через стандартні команди **OpenSSH**,
  що їх застосунок запускає як дочірні процеси.
- Мова інтерфейсу — українська.

## Файли

| Файл | Призначення |
|---|---|
| `electron/` | Код програми (див. розділ «Electron-версія»): `main.js`, `preload.js`, `index.html`, `renderer.js`, `package.json`, `.gitignore` (`node_modules/`) |
| `start.sh` | macOS/Linux: за згодою (`[т/Н]`, `-y` — без питань) ставить Node.js ≥ 22 (brew / nvm), `npm install` Electron, на Linux — бракуючі бібліотеки Electron, і запускає `npm start` |
| `start.cmd`, `start.ps1` | Те саме для Windows (Node.js через `winget`). `start.ps1` — UTF-8 з BOM, інакше Windows PowerShell 5.1 псує кирилицю |
| `SSH Key Maker.app` | macOS: запуск клацанням. `Contents/MacOS/launcher` — shell-скрипт: є `electron/node_modules/electron/dist/Electron.app` → `open -n -a <він> --args <тека>/electron`, немає → `open -a Terminal start.sh`. Логіка вбудована, бо скрипт з теки проєкту .app виконати не може (TCC не пускає в «Робочий стіл», «Документи»). `LSUIElement` — без своєї іконки в Dock. Має лежати в теці проєкту |
| `launcher.sh` | Linux: те саме для ярлика `.desktop` — `dist/electron <тека>/electron`, інакше термінал (`x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`) зі `start.sh`, який після помилки чекає Enter |
| `launcher.vbs` | Windows: те саме для ярлика `.lnk` — `dist\electron.exe` без вікна консолі, інакше `start.cmd`. ASCII, CRLF |
| `.gitignore`, `.gitattributes` | Не комітити згенеровані ярлики (`SSH Key Maker.lnk`, `SSH Key Maker.desktop`) і `.DS_Store`; `*.cmd`, `*.vbs` — з CRLF |
| `keys/` | Створюється програмою в режимі «Лише ключі». Містить `.gitignore` з `*` |
| `Makefile` | Обгортка: `make` / `make start` (= `./start.sh`), `make help`, `make icons`, `make clean` (видаляє `electron/node_modules`) |
| `make-icons.sh` | З `icon.png` робить `icons/`: `icon.ico` 16–256 (Windows), `hicolor/<N>x<N>/apps/ssh-key-maker.png` (Linux; 512 — іконка вікна Electron) і `ssh-key-maker.desktop` (Linux), а ще `SSH Key Maker.app/Contents/Resources/AppIcon.icns` (macOS, 16–1024). Потрібні `sips`, `iconutil` (macOS) і `python3`. Запуск: `make icons` |
| `icons/` | Згенеровані іконки — не правити вручну, міняти `icon.png` і запускати `make icons` |
| `icon.png` | Іконка застосунку, квадрат 1254×1254 (ключ + термінал + «SSH», фіолетово-синій градієнт на темному) |
| `README.md` | Інструкція для людини |
| `AGENTS.md` | Ця специфікація |

## Інтерфейс (одне вікно, мін. ~560×720)

Згори вниз:

- **Шапка:** іконка застосунку (`icons/hicolor/128x128/…`, 44 px, заокруглена), назва «SSH Key Maker»
  і підзаголовок «Створення SSH-ключів і налаштування входу на сервер», праворуч — посилання
  «GitHub ↗» на https://github.com/maksimilianius1989/ssh-key-maker (відкривається в системному браузері).

0. **Режим** (сегментований перемикач, типово «Повне налаштування»):
   | Режим | Куди ключ | Конфіг | Сервер | Поля |
   |---|---|---|---|---|
   | Лише ключі (keys) | `<тека проєкту>/keys/` | ні | ні | Назва, Пароль ключа |
   | Ключі в ~/.ssh | `~/.ssh/` | ні | ні | Назва, Пароль ключа |
   | Повне налаштування | `~/.ssh/` | так | так | усі |

   Тека проєкту — змінна оточення `SSHKM_PROJECT_DIR`, інакше батьківська тека `electron/`.
   Під формою — рядок «Куди:» зі шляхом.
1. **Форма** (у ключових режимах видно лише Назву й Пароль ключа)
   | Поле | Тип | Перевірка |
   |---|---|---|
   | Назва | текст | обов'язкове, `^[A-Za-z0-9._-]+$` — стає `Host` у конфігу й частиною імені файлу ключа |
   | Хост | текст | обов'язкове, без пробілів |
   | Порт | текст | ціле 1–65535, типово `22` |
   | Користувач | текст | обов'язкове, без пробілів |
   | Пароль сервера | приховане | обов'язкове. Після завершення очищується |
   | Пароль ключа (passphrase) | приховане | необов'язкове |
2. **Рядок дії:** кнопка «Згенерувати» (типова, Enter) · **лампочка** (коло ~18 px зі світінням) ·
   підпис стану · спінер під час роботи. Поки йде робота, форма й кнопка неактивні.
3. **Публічний ключ:** моноширинний текст, який можна виділити, кнопки «Показати у Finder»
   (у Windows і Linux — «Показати в теці»; виділяє приватний ключ у файловому менеджері) і
   «Копіювати» (в буфер обміну). Обидві неактивні, поки ключа немає.
4. **Журнал:** моноширинний текст, що прокручується. Рядки з префіксами `→` (крок), `✓` (успіх),
   `⚠︎` (попередження), `✗` (помилка).

Стани лампочки: сірий «Очікує» → жовтий «Виконується…» → зелений «З'єднання працює» (у ключових
режимах — «Ключі створено») / червоний «Помилка».

## Алгоритм після «Згенерувати»

Кожен крок пише в журнал. Перша помилка зупиняє процес, і лампочка стає червоною.
Усі довгі дії виконуються поза потоком інтерфейсу.

Ключові режими виконують лише кроки 0–4 (без перевірки `Host`), у теці свого режиму, з коментарем
ключа `-C <назва>`, і завершуються зеленою лампочкою.

0. **Валідація полів** (таблиця вище; у ключових режимах — лише Назва).
1. **Перевірка залежностей:** `ssh-keygen`, `ssh-copy-id`, `ssh`, `ssh-add` (у ключових режимах — лише `ssh-keygen`).
   - Шукати за **явним списком тек**, а не лише в `PATH`: GUI-застосунок не успадковує PATH оболонки.
     Системні теки — **першими**.
   - Бракує команди → **діалог-запитання** зі списком відсутніх → лише за згодою встановити (таблиця
     «Платформи»). Немає й менеджера пакетів → запропонувати відкрити термінал з командою його
     встановлення й зупинитись. Відмова → червона лампочка.
2. **Тека ключа** (`~/.ssh` або `keys/`): створити, якщо немає (права 700). Для `keys/` — ще й
   `.gitignore` з `*`, якщо його немає, щоб приватні ключі не потрапили в git.
3. **Захист від перезапису:** якщо існує `<тека ключа>/id_ed25519_<назва>` або `.pub` → стоп.
   Лише в повному режимі: якщо в `~/.ssh/config` є рядок `Host`, серед шаблонів якого точно є
   `<назва>` → стоп.
4. **Генерація:** `ssh-keygen -t ed25519 -f <тека ключа>/id_ed25519_<назва> -N <passphrase> -C <user>@<назва>`
   (порожній `-N ""`, якщо пароля ключа немає). Прочитати `.pub` і показати у вікні.
5. **Конфіг:** скопіювати наявний у `config.bak-<ISO-дата, «:»→«-»>` (наявну копію не
   перезаписувати). Дописати в **кінець** (з порожнім рядком-відступом) і виставити права 600
   (у Windows — `icacls <config> /inheritance:r /grant:r <користувач>:F`, невдача — попередження):
   ```
   Host <назва>
       HostName <хост>
       Port <порт>
       User <користувач>
       IdentityFile ~/.ssh/id_ed25519_<назва>
       IdentitiesOnly yes
       AddKeysToAgent yes
       IgnoreUnknown UseKeychain
       UseKeychain yes
   ```
   `UseKeychain` — лише для macOS. `IgnoreUnknown` перед ним рятує ssh, зібраний не Apple.
   На Windows і Linux ці два рядки не писати.
6. **Askpass:** секрети передаються в ssh **тільки через змінну оточення**, не через аргументи.
   Тимчасовий скрипт (права 700, видаляється наприкінці) друкує `$SSHKM_SECRET`. Оточення:
   `SSH_ASKPASS=<скрипт>`, `SSH_ASKPASS_REQUIRE=force`, `DISPLAY=:0`, stdin = `/dev/null`.
   Потрібен OpenSSH ≥ 8.4.
7. **Агент (лише якщо є пароль ключа)** — до заливання, щоб `ssh-copy-id` при пробі ключем не
   спитав passphrase через askpass і не отримав замість неї пароль сервера:
   `ssh-add [--apple-use-keychain] <ключ>`, де `SSHKM_SECRET=<passphrase>`. Прапор `--apple-use-keychain`
   додавати лише для системного `/usr/bin/ssh-add` у macOS. Невдача — лише попередження.
8. **Заливання:** `SSHKM_SECRET=<пароль сервера>`, `PATH` починається з теки обраного `ssh`
   (`ssh-copy-id` — shell-скрипт, що кличе `ssh` з PATH):
   ```
   ssh-copy-id -i <ключ>.pub -p <порт> -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15
     -o PreferredAuthentications=publickey,password,keyboard-interactive -o NumberOfPasswordPrompts=1 <user>@<хост>
   ```
   Вивід — у журнал. Ненульовий код → стоп.
   У Windows `ssh-copy-id` немає: `ssh -p <порт> <ті самі -o> <user>@<хост> "umask 077; mkdir -p ~/.ssh
   && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`,
   публічний ключ — у stdin (сервер має бути Unix). Askpass-оточення те саме.
9. **Тест:** `ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new <назва> echo SSHKM_OK`.
   Звертатись саме за **назвою**: так заразом перевіряється новий запис конфігу.
   Код 0 і в виводі `SSHKM_OK` → зелена лампочка, інакше червона з виводом.
10. **Наприкінці:** очистити поле пароля сервера, розблокувати форму.

## Незмінні правила (не порушувати в жодній реалізації)

- Ніколи не перезаписувати наявні ключі й записи `Host`. Перед правкою конфігу — резервна копія.
- Секрети — лише через оточення чи stdin. Не в аргументах, не на диску (крім askpass-скрипта,
  який сам секрету не містить), не в журналі.
- `StrictHostKeyChecking=accept-new`, а не `no`: новий сервер приймаємо, змінений відбиток — ні.
- Нічого не встановлювати без явної згоди: діалог у застосунку, запитання `[т/Н]` у скриптах запуску
  (прапор `-y` — це згода наперед; без терміналу й без `-y` — нічого не ставити).
- Права: `~/.ssh` і `keys/` 700, приватний ключ 600 (його виставляє `ssh-keygen`), `config` 600.

## Платформи

| | macOS | Linux | Windows 10/11 |
|---|---|---|---|
| Реалізовано | Electron | Electron | Electron |
| Інші варіанти GUI | SwiftUI | Python + GTK4 / Qt (PySide6), Tauri | C# WPF / WinUI 3, Tauri |
| Де шукати команди | `/usr/bin`, `/opt/homebrew/bin`, `/usr/local/bin` | `/usr/bin`, `/usr/local/bin` | `%SystemRoot%\System32\OpenSSH`, далі `PATH` |
| Встановлення бракуючого | `brew install openssh`; немає brew → Термінал з інсталятором з brew.sh | `apt-get install -y openssh-client` / `dnf install -y openssh-clients` / `pacman -S --noconfirm openssh` / `zypper install openssh-clients` — через `pkexec` (графічний запит пароля); немає `pkexec` → підказати команду з `sudo` і зупинитись | `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0` з підвищенням прав (UAC, `Start-Process -Verb RunAs`), або `winget install Microsoft.OpenSSH.Beta` |
| `ssh-copy-id` | є | є (у пакеті клієнта) | **немає** → відтворити вручну: `type <ключ>.pub \| ssh -p <порт> <user>@<хост> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`. Для Windows-сервера — інший шлях: `administrators_authorized_keys` для адміністраторів |
| Askpass | `.sh` у тимчасовій теці | так само | `.cmd`-файл (`@echo %SSHKM_SECRET%`); OpenSSH для Windows підтримує `SSH_ASKPASS_REQUIRE=force` з 8.9 |
| Агент і пароль ключа | `ssh-add --apple-use-keychain`; `UseKeychain yes` у конфігу | `ssh-add`; без `UseKeychain` | служба `ssh-agent` (за потреби `Set-Service ssh-agent -StartupType Automatic` з правами адміністратора), `ssh-add`; без `UseKeychain` |
| Шляхи | `~/.ssh` | `~/.ssh` | `%USERPROFILE%\.ssh`, у конфігу `IdentityFile ~/.ssh/...` теж працює |
| Права файлів | chmod | chmod | `ssh-keygen` ставить ACL сам; на `config` не має бути прав для інших користувачів (`icacls`) |
| Пакування | `.app` (напр. electron-builder) з `.icns` з `icon.png` (`sips` + `iconutil`), ad-hoc `codesign` | `.desktop`-файл + `icon.png`, AppImage або просто скрипт | `.exe` з `.ico` (з `icon.png`), за бажання MSIX |

## Electron-версія (`electron/`)

| Файл | Що робить |
|---|---|
| `main.js` | Головний процес: уся логіка «Алгоритму» й «Платформ» (пошук і встановлення OpenSSH, генерація, конфіг, askpass, заливання, тест). Команди — `child_process.spawn`, асинхронно; stdin — `ignore`, крім заливання у Windows |
| `preload.js` | `contextBridge` → `window.sshkm`: `paths()`, `generate(form)`, `reveal(path)`, `copy(text)`, `openRepo()`, `onLog(fn)`, `onKey(fn)` |
| `index.html` | Вікно 620×780 (мін. 560×720), світла й темна тема за системою, CSP без зовнішніх ресурсів |
| `renderer.js` | Стан форми, лампочка, блокування під час роботи, очищення пароля сервера наприкінці |
| `package.json` | `npm start` = `electron .`; Electron зафіксовано точною версією в `devDependencies` |

IPC: `generate` повертає `true`/`false` (зелена/червона лампочка), рядки журналу йдуть подією `log`,
готовий ключ — подією `key` `{key, keyPath}`. Валідація — у головному процесі.
Безпека вікна: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; вікно нікуди не переходить
і не відкриває нових вікон, а `openRepo` відкриває лише адресу репозиторію, задану в головному процесі.
Іконка — `icons/hicolor/512x512/apps/ssh-key-maker.png` (у macOS — ще й у Dock).

### Скрипти запуску

`start.sh` (macOS, Linux; `make start`) і `start.cmd` → `start.ps1` (Windows). Порядок:

1. **Node.js ≥ 22** (вимога Electron). Спершу шукає вже наявний: `PATH`, `/opt/homebrew/bin`,
   `/usr/local/bin`, nvm у `$NVM_DIR` (типово `~/.nvm`). Бракує — питає й ставить:
   macOS — `brew install node` (немає brew — спершу питає й ставить Homebrew з brew.sh);
   Linux — nvm `v0.40.3` у `~/.nvm` (без sudo, не чіпає профіль оболонки), далі `nvm install 22`;
   Windows — `winget install --id OpenJS.NodeJS.LTS`, потім перечитує `PATH` з реєстру; немає winget →
   підказати nodejs.org і зупинитись.
2. **Electron**: перевірка — `require('electron')` повертає шлях до наявного бінарника. Немає →
   питає й робить `npm install` у `electron/`.
3. **Лише Linux:** `ldd` бінарника Electron; бракує бібліотек → питає й ставить через
   `sudo apt-get` / `dnf` / `pacman` (NSS, GTK3, GBM, ALSA, XScrnSaver, xshmfence, DRM).
4. **Ярлики з іконкою** (повторний запуск їх оновлює; невдача — лише `⚠︎`):
   Windows — `SSH Key Maker.lnk` у теці проєкту й у меню «Пуск» (`wscript.exe "<тека>\launcher.vbs"`,
   іконка `icons\icon.ico`); Linux — `ssh-key-maker.desktop` у `~/.local/share/applications` і
   `SSH Key Maker.desktop` у теці проєкту (`Exec="<тека>/launcher.sh"`, абсолютний шлях до іконки,
   `gio set … metadata::trusted true`). macOS — нічого: `SSH Key Maker.app` уже в репозиторії.
5. `npm start`.

`start.cmd` після невдачі робить `pause`, щоб при запуску подвійним клацанням вікно не зникло.

Відповідь `т`/`y` (будь-який регістр) — так, решта — ні. Відмова на будь-якому кроці → `✗` і вихід
з кодом 1. `start.ps1` — UTF-8 **з BOM** (інакше Windows PowerShell 5.1 псує кирилицю);
`start.cmd` — лише ASCII, запускає його з `-ExecutionPolicy Bypass`. OpenSSH скрипти не ставлять —
це робить сам застосунок (крок 1 «Алгоритму»).

## Як перевіряти

- Збірка та запуск: процес живе кілька секунд без падіння. Electron: `./start.sh -y` на чистій
  машині ставить Node.js і Electron та відкриває вікно; повторний запуск нічого не питає.
- Скрипт без терміналу й без `-y` (`./start.sh </dev/null`) → нічого не ставить, код 1.
- Сухий прогін без сервера: невалідні поля → червона лампочка з причиною. Наявна назва → стоп без змін.
- Повний прогін — тестовий сервер (наприклад, `docker run -p 2222:2222 linuxserver/openssh-server`
  з `PASSWORD_ACCESS=true`). Очікувано: файли ключа, новий блок у кінці конфігу, резервна копія,
  зелена лампочка, `ssh <назва>` працює без пароля.
- Після тесту прибрати: ключі, блок `Host`, рядок у `known_hosts` (`ssh-keygen -R "[хост]:порт"`).
