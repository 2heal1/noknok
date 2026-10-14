#!/bin/bash
set -euo pipefail
# Administrator-only installation. Inputs are a PUBLIC key and root config;
# private keys and caller-supplied shell commands are never accepted.
exec /usr/bin/python3 "$(cd -- "$(dirname -- "$0")" && pwd -P)/install.py" "$@"
