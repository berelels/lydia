const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { HOME, paths } = require('./voice');

/**
 * Installs hearing and a nicer voice into ~/.local/share/lydia/voice, only when
 * the user presses "Install" in the setup wizard. Nothing needs root.
 * - hearing: whisper.cpp through pywhispercpp (prebuilt wheels for x64 and ARM,
 *   nothing to compile) in the voice's own Python venv + the "small" model
 * - speaking: Kokoro (kokoro-onnx in its own Python venv) + model and voices
 * onStep({ step, done, error }) reports progress.
 */

const WHISPER_PKG = 'pywhispercpp==1.5.1';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin';
const KOKORO_PKG = 'kokoro-onnx==0.6.1';
const KOKORO_FILES = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';

/** What it will download, for the wizard to show before the user says yes. */
const PLAN = [
  { part: 'hear', what: 'whisper.cpp (pywhispercpp 1.5.1, numpy)', from: 'pypi.org', mb: 25 },
  { part: 'hear', what: 'ggml-small.bin', from: 'huggingface.co/ggerganov', mb: 488 },
  { part: 'speak', what: 'Kokoro (kokoro-onnx, onnxruntime)', from: 'pypi.org', mb: 180 },
  { part: 'speak', what: 'kokoro-v1.0.onnx + voices-v1.0.bin', from: 'github.com/thewh1teagle/kokoro-onnx', mb: 354 },
];

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
    let err = '';
    p.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}: ${err.trim().split('\n').pop()}`))));
  });
}

/** Downloads to a .part file and renames it when complete (an interrupted download never looks finished). */
async function download(url, file) {
  if (fs.existsSync(file)) return;
  await exec('curl', ['-fL', '--retry', '3', '-o', `${file}.part`, url]);
  fs.renameSync(`${file}.part`, file);
}

async function install(lang, onStep, { hear = true, speak = true } = {}) {
  const step = async (name, fn) => {
    onStep({ step: name });
    await fn();
    onStep({ step: name, done: true });
  };
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const venv = async () => {
      if (!fs.existsSync(paths.python)) await exec('python3', ['-m', 'venv', path.dirname(path.dirname(paths.python))]);
    };
    if (hear && !fs.existsSync(paths.sttReady)) {
      await step('whisper-get', async () => {
        await venv();
        await exec(paths.python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', WHISPER_PKG]);
        fs.writeFileSync(paths.sttReady, `${WHISPER_PKG}\n`);
      });
    }
    if (hear) await step('model', () => download(MODEL_URL, paths.model));
    if (speak) {
      await step('kokoro', async () => {
        await venv();
        await exec(paths.python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', KOKORO_PKG]);
      });
      await step('voice', async () => {
        await download(`${KOKORO_FILES}/kokoro-v1.0.onnx`, paths.kokoro);
        await download(`${KOKORO_FILES}/voices-v1.0.bin`, paths.voices);
      });
    }
    onStep({ step: 'all', done: true });
    return { ok: true };
  } catch (err) {
    onStep({ step: 'error', error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { install, PLAN };
