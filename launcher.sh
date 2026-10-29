#!/bin/sh
# Linux: запуск SSH Key Maker клацанням по ярлику .desktop, без терміналу (macOS — «SSH Key Maker.app»).
# Electron уже встановлено → одразу відкриває вікно. Ні → відкриває термінал зі start.sh, який
# за згодою встановить Node.js та Electron і запустить програму. Наступні запуски — без терміналу.
ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/electron/node_modules/electron/dist"

[ -x "$DIST/electron" ] && exec "$DIST/electron" "$ROOT/electron"

# Перший запуск: термінал зі start.sh. Після помилки вікно не закривається одразу
run='cd "$1" && ./start.sh || { echo; printf "Натисніть Enter, щоб закрити "; read _; }'
for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
  command -v "$t" >/dev/null 2>&1 || continue
  case "$t" in
    gnome-terminal) exec "$t" -- sh -c "$run" sh "$ROOT" ;;
    xfce4-terminal) exec "$t" -x sh -c "$run" sh "$ROOT" ;;
    *)              exec "$t" -e sh -c "$run" sh "$ROOT" ;;
  esac
done
msg="Не знайдено термінала. Запустіть у терміналі: $ROOT/start.sh"
command -v zenity >/dev/null 2>&1 && zenity --error --text="$msg"
echo "✗ $msg" >&2
exit 1
