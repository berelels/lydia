/**
 * Packaged, the app lives inside resources/app.asar. Electron reads files in
 * there, but other programs (python3, the GNOME Shell) can't: those files are
 * kept unpacked beside it (package.json, build.asarUnpack), and this points at them.
 */
const unpacked = (p) => p.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked');

module.exports = { unpacked };
