#!/bin/sh
set -eu

case "$(uname -s)" in Darwin|Linux) ;; *) echo 'Crew supports macOS and Linux.' >&2; exit 1;; esac
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 24 or newer, then rerun this installer.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || { echo 'Node.js 24 or newer is required.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo 'Install npm with your Node.js distribution.' >&2; exit 1; }

# Accept the reviewed local pilot artifact until this exact version is published.
package=${1:-@bosun-sh/crew-cli@0.3.0-rc.1}
case "$package" in
  @bosun-sh/crew-cli@0.3.0-rc.1) ;;
  /*.tgz|./*.tgz) [ -f "$package" ] || { echo 'Package file not found.' >&2; exit 1; } ;;
  *) echo 'Pass an absolute or ./ path to the reviewed CLI tarball.' >&2; exit 1;;
esac
npm install --global --prefix "$HOME/.local" --ignore-scripts "$package"
"$HOME/.local/bin/crew" --version
printf '%s\n' 'Add "$HOME/.local/bin" to PATH, then run crew setup . inside your repository.'
