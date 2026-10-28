#!/usr/bin/env bash
# Inicia o servidor CuidAção.
# O VS Code instalado via Flatpak não enxerga o Node.js do sistema,
# então usamos flatpak-spawn --host quando estivermos dentro do Flatpak.
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  exec node server.js
elif [ -n "$FLATPAK_ID" ] && command -v flatpak-spawn >/dev/null 2>&1; then
  exec flatpak-spawn --host --directory="$PWD" node server.js
else
  echo "Node.js não encontrado. Instale com: sudo pacman -S nodejs npm" >&2
  exit 1
fi

