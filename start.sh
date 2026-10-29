#!/bin/sh
# Встановлює (за згодою) усе потрібне й запускає Electron-версію SSH Key Maker. macOS і Linux.
#   ./start.sh       — перевірити Node.js, Electron і запустити
#   ./start.sh -y    — не питати, погоджуватись на все
# Windows — start.cmd. OpenSSH програма перевіряє й пропонує встановити сама.
set -e
cd "$(dirname "$0")/electron"
NODE_MIN=22
YES=0
[ "$1" = "-y" ] && YES=1

# Теки, яких може не бути в PATH (Homebrew, nvm)
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
load_nvm() {
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  set +e; . "$NVM_DIR/nvm.sh"; set -e
}

confirm() {
  [ "$YES" = 1 ] && return 0
  if [ ! -t 0 ]; then
    echo "✗ $1 — потрібна відповідь, а термінал неінтерактивний. Запустіть із -y або в терміналі."
    return 1
  fi
  printf '%s [т/Н] ' "$1"
  read -r a
  case "$a" in т*|Т*|y*|Y*) return 0 ;; *) return 1 ;; esac
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

install_node() {
  case "$(uname -s)" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        confirm "Для Node.js потрібен Homebrew. Встановити Homebrew (brew.sh)?" || return 1
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
      fi
      confirm "Встановити Node.js через Homebrew (brew install node)?" || return 1
      brew install node
      ;;
    *)
      # Пакети дистрибутивів часто мають старий Node — ставимо через nvm у домашню теку, без sudo
      if ! load_nvm; then
        confirm "Встановити nvm (менеджер версій Node.js) у ~/.nvm?" || return 1
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
        load_nvm
      fi
      confirm "Встановити Node.js $NODE_MIN через nvm?" || return 1
      nvm install "$NODE_MIN"
      nvm use "$NODE_MIN" >/dev/null
      ;;
  esac
}

# Linux: на мінімальних системах Electron бракує бібліотек GTK/NSS/ALSA
check_linux_libs() {
  [ "$(uname -s)" = Linux ] || return 0
  bin="$(node -p "require('electron')")"
  missing="$(ldd "$bin" 2>/dev/null | awk '/not found/ {print $1}' | tr '\n' ' ')"
  [ -n "$missing" ] || return 0
  echo "⚠︎ Electron бракує бібліотек: $missing"
  if command -v apt-get >/dev/null 2>&1; then
    confirm "Встановити їх (sudo apt-get install)?" || return 1
    sudo apt-get install -y libnss3 libgtk-3-0 libgbm1 libxss1 libxshmfence1 libdrm2 \
      && { sudo apt-get install -y libasound2t64 || sudo apt-get install -y libasound2; }
  elif command -v dnf >/dev/null 2>&1; then
    confirm "Встановити їх (sudo dnf install)?" || return 1
    sudo dnf install -y nss gtk3 mesa-libgbm alsa-lib libXScrnSaver libxshmfence libdrm
  elif command -v pacman >/dev/null 2>&1; then
    confirm "Встановити їх (sudo pacman -S)?" || return 1
    sudo pacman -S --needed --noconfirm nss gtk3 mesa alsa-lib libxss libxshmfence libdrm
  else
    echo "✗ Встановіть ці бібліотеки менеджером пакетів свого дистрибутива."
    return 1
  fi
}

# 1. Node.js і npm
[ "$(node_major)" -ge "$NODE_MIN" ] || load_nvm || true
if [ "$(node_major)" -lt "$NODE_MIN" ]; then
  echo "→ Потрібен Node.js $NODE_MIN або новіший (з ним іде npm). Зараз: $(node -v 2>/dev/null || echo 'немає')."
  install_node || { echo "✗ Без Node.js запустити не можу."; exit 1; }
  if [ "$(node_major)" -lt "$NODE_MIN" ]; then
    echo "✗ Node.js $NODE_MIN так і не знайдено. Відкрийте новий термінал і запустіть знову."
    exit 1
  fi
fi
echo "✓ Node.js $(node -v)"

# 2. Electron та інші залежності з package.json
if ! node -e "require('fs').accessSync(require('electron'))" >/dev/null 2>&1; then
  confirm "Встановити Electron і залежності (npm install, ~200 МБ)?" || { echo "✗ Скасовано."; exit 1; }
  npm install
fi
echo "✓ Electron $(node -p "require('electron/package.json').version")"
check_linux_libs || { echo "✗ Без цих бібліотек Electron не запуститься."; exit 1; }

# 3. Linux: ярлики з іконкою — у меню застосунків і в теці проєкту. Ведуть на launcher.sh,
#    тож далі програма запускається клацанням, без терміналу. У macOS є «SSH Key Maker.app»
desktop_shortcuts() {
  [ "$(uname -s)" = Linux ] || return 0
  root="$(cd .. && pwd)"
  menu="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$menu"
  for f in "$menu/ssh-key-maker.desktop" "$root/SSH Key Maker.desktop"; do
    cat > "$f" <<EOF
[Desktop Entry]
Type=Application
Name=SSH Key Maker
Comment=Створення SSH-ключів і налаштування входу на сервер
Exec="$root/launcher.sh"
Icon=$root/icons/hicolor/256x256/apps/ssh-key-maker.png
Terminal=false
Categories=Utility;Network;
EOF
    chmod +x "$f"
  done
  # GNOME запускає .desktop з теки лише після «Дозволити запуск» — позначаємо довіреним одразу
  command -v gio >/dev/null 2>&1 && gio set "$root/SSH Key Maker.desktop" metadata::trusted true 2>/dev/null || true
  echo "✓ Ярлики: меню застосунків і «SSH Key Maker.desktop» у теці проєкту"
}
desktop_shortcuts || echo "⚠︎ Не вдалося створити ярлики — запускайте ./start.sh"

# 4. Запуск
echo "→ Запускаю SSH Key Maker…"
exec npm start --silent
