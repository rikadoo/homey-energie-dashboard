#!/bin/sh
# Start als root, zorg dat de datamap van gebruiker 'node' is en start dan de app als 'node'.
# Zo werkt het ook als de map 'data' op de host door root is aangemaakt.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
