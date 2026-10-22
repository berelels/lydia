# Third-party notices

Lydia is under her own license (see `LICENSE`). These parts belong to others and keep their licenses.

## Shipped with Lydia

| Component | License | Where |
| --- | --- | --- |
| [Electron](https://www.electronjs.org) (Chromium, Node.js) | MIT (Chromium: BSD-3-Clause and others, listed in `LICENSES.chromium.html` inside the package) | the app's runtime |
| [GSAP](https://gsap.com) | GSAP Standard "no charge" license | the site's animations |
| [Lenis](https://github.com/darkroomengineering/lenis) | MIT | the site's smooth scroll |
| [Inter](https://rsms.me/inter/) | SIL Open Font License 1.1 | the site's type (from Google Fonts); the app uses it when installed |

## Downloaded at your request (the voice, in the setup wizard)

Lydia does not ship these: pressing "Install" in her setup downloads them into `~/.local/share/lydia/voice`, on your computer.

| Component | License | From |
| --- | --- | --- |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) through [pywhispercpp](https://github.com/absadiki/pywhispercpp) | MIT | pypi.org |
| Whisper "small" model (`ggml-small.bin`), by OpenAI | MIT | huggingface.co/ggerganov/whisper.cpp |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model and voices | Apache-2.0 | github.com/thewh1teagle/kokoro-onnx |
| [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | MIT | pypi.org |
| [ONNX Runtime](https://onnxruntime.ai) | MIT | pypi.org |
| [phonemizer](https://github.com/bootphon/phonemizer) and [espeak-ng](https://github.com/espeak-ng/espeak-ng) (through espeakng-loader), used by kokoro-onnx | GPL-3.0 | pypi.org |
| NumPy and the other Python packages they need | BSD, MIT, Apache-2.0, MPL-2.0, PSF | pypi.org |

## Services she talks to (only when you use them)

| Service | Terms |
| --- | --- |
| [Open-Meteo](https://open-meteo.com) (weather) | data under CC BY 4.0; free for non-commercial use |
| [ipwho.is](https://ipwho.is) (a rough location for the weather, when no city is set) | its terms of use |
| Google Gemini (chat and natural voice, with your own key) | Google's API terms |
| Anthropic Claude (chat, through your own `claude` login) | Anthropic's terms |
| Cloudflare (speed test), DuckDuckGo (a song's link), GitHub (new versions) | their terms of use |

Weather data by [Open-Meteo.com](https://open-meteo.com).
