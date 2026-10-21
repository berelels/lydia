const fs = require('fs');
const path = require('path');

/**
 * AppImage only: the executable becomes a small script that adds, before
 * Chromium starts,
 * - --no-sandbox where the system blocks the user namespaces its sandbox
 *   needs (Ubuntu 23.10+): an AppImage can't carry the setuid helper a .deb
 *   installs, so it wouldn't even open there;
 * - --ozone-platform=x11 under Wayland: main.js would otherwise start itself
 *   again with it, and the AppImage is unmounted when the first one exits.
 * The .deb and .rpm are built separately and stay untouched.
 */
exports.default = async (context) => {
  if (!context.targets.every((t) => t.name === 'appImage')) return;
  const name = context.packager.executableName;
  const bin = path.join(context.appOutDir, name);
  fs.renameSync(bin, `${bin}.bin`);
  fs.writeFileSync(
    bin,
    `#!/bin/sh
here="$(dirname "$(readlink -f "$0")")"
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] || [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ]; then
  set -- --no-sandbox "$@"
fi
if [ -n "$WAYLAND_DISPLAY" ] && [ "$LYDIA_NATIVE_WAYLAND" != 1 ]; then
  set -- --ozone-platform=x11 "$@"
fi
exec "$here/${name}.bin" "$@"
`,
    { mode: 0o755 },
  );
};
