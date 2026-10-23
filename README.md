<p align="center">
  <img src="assets/logo-256.png" width="128" alt="Lydia">
</p>

<h1 align="center">Lydia</h1>

<p align="center">A workstation for Linux that lives at the top of your screen, like a dynamic island.<br>
Everything you reach for is one move of the mouse (or the Super key) away.</p>

<p align="center">
  <img src="assets/screens/controls.png" width="49%" alt="Controls: network, Bluetooth, night light, do not disturb, dark mode, sound in and out, and the player">
  <img src="assets/screens/today.png" width="49%" alt="Today: clock, weather, the week, timers and tasks">
  <img src="assets/screens/tasks.png" width="49%" alt="System: CPU, RAM and disk, uptime, speed test and the busiest apps">
  <img src="assets/screens/apps.png" width="49%" alt="Apps: search, favorites and every installed app">
  <img src="assets/screens/wall.png" width="49%" alt="Wallpapers: the one in use flagged, the others open up under the mouse">
  <img src="assets/screens/chat.png" width="49%" alt="Chat with Lydia">
</p>

## What it does

**Closed**, it is a small black island at the top center: a clock and/or your system's numbers (RAM, CPU, disk, temperature) in turns. When something plays (and nothing is below it) it becomes a small player: the cover blurred behind, previous/next, that app's own volume, and a progress bar that dances with the sound. Over a maximized window it shrinks to a thin handle; in fullscreen, to a small notch.

**Open** (hover it, or press Super), it is a set of tabs around a clock with the temperature:

- **Controls**: Wi-Fi and Bluetooth (on/off, and a list to connect to networks and devices), night light, do not disturb, dark mode, sound output and microphone with their levels, screen brightness, and the player.
- **Today**: a big clock, the weather where you are, the week, timers, and tasks with a time (she reminds you, out loud too).
- **System**: CPU, RAM and disk rings, temperatures, uptime, a speed test, and the busiest apps (end one with two clicks).
- **Clipboard**: what you copied (text and images), with search, pinning, pause; passwords and keys are never kept. Click to paste.
- **Apps**: every installed app, in your language, with search and favorites (right click).
- **Wallpapers**: from a folder of yours, applied with a click.
- **Chat**: talk to Lydia (Claude, Gemini or a local Ollama model). Nothing is saved.
- **Notifications** (the bell): WhatsApp, Discord, everything the system received; open or dismiss them.
- **Power**, the **workspaces** overview, and **settings** (look, language, font, the closed bar, voice, the Super key).

**Voice**: press Super+Alt+Space and talk. She opens apps and sites, plays music on Spotify or YouTube, sets the volume, timers, the theme, locks the screen, and answers out loud with a natural voice (Gemini) or a local one (Kokoro). After answering she keeps listening for a moment, so you can just reply.

**Dictation**: press Super+Alt+D, talk, and the cleaned-up text is typed where you are.

**On GNOME** her helper extension can also hide GNOME's top bar (she takes its place) and give her the Super key.

Languages: English, Portuguese (Brazil) and Spanish.

## Installing

Each push to `main` builds the packages on GitHub Actions (the run's **lydia-linux** and **lydia-flatpak** artifacts), for x64 and arm64. **The `.deb` is the recommended one**: it is the package that gets every feature.

| Package | For |
| --- | --- |
| `lydia_<version>_amd64.deb` / `_arm64.deb` (recommended) | Ubuntu 22.04+, Debian 12+, Mint 21+, Pop!_OS, Zorin, elementary |
| `lydia-<version>.x86_64.rpm` / `.aarch64.rpm` | Fedora, openSUSE |
| `Lydia-<version>.AppImage` / `-arm64.AppImage` | Any other distro (Arch, Manjaro...) |
| `Lydia-<version>.flatpak` (x64) | Any distro with Flatpak. She runs the system's tools on the host (`flatpak-spawn --host`); the busiest-apps list only sees her own sandbox |

```bash
sudo apt install ./lydia_1.1.1_amd64.deb
```

Or build the `.deb` here (`npm run dist`), or all of them (`npm run dist:all`, needs `rpm` for the `.rpm`). The Flatpak: `npm run dist:flatpak`, with `flatpak-builder` (or `PATH="$PWD/build:$PATH" npm run dist:flatpak` to use Flathub's `org.flatpak.Builder`).

She checks once a day for a newer release on GitHub and says so (the Flatpak is updated by the store instead).
Then open **Lydia** from the apps menu; the setup wizard can make her start on login.

## Running from the source

Requirements: Linux, Node.js 20+, Python 3 with GTK bindings (`python3-gi`), PipeWire (`wpctl`, `pw-record`, `pw-play`) or PulseAudio (`pactl`, `parec`, `pacat`, `paplay`), and the usual desktop tools (`nmcli`, `bluetoothctl`, `gdbus`, `gsettings`). On X11 she also uses `xprop` and `xdotool`. The `claude` command, Ollama and a Gemini key are optional (one of them is enough for the chat; the Gemini key also gives her the natural voice).

```bash
npm install
npm start
```

A setup wizard opens the first time (language, chat engine, voice, the GNOME extension, start on login). You can reopen it from her menu (the three dots): **Set up Lydia…**

```bash
npm test
```

## Desktops

| Desktop | Status |
| --- | --- |
| GNOME 42 to 51 (X11 or Wayland) with the Lydia helper extension (`gnome-extension/`; `legacy/` for 42–44) | Everything, including hiding the top bar, the Super key and her own notifications |
| GNOME on X11 without the extension | Works, without those three |
| Cinnamon, MATE, XFCE, KDE Plasma on X11 | The island and the tabs, the wallpaper, dark mode, logging out and the system settings; night light on Cinnamon and KDE, do not disturb on Cinnamon, MATE and XFCE |
| KDE Plasma on Wayland | The same, with a small KWin script (`app/desktop/kwin-script/`, loaded while she runs) for the pointer and fullscreen windows |
| Other Wayland desktops | She runs, but can't see the pointer or fullscreen windows |

Tested on Zorin OS 18 (GNOME 46, X11), from the source and as the built package.

## Privacy

Everything runs on your computer and nothing is recorded. What leaves it, and only when you use it:

- **Chat and the natural voice**: the engine you pick (Claude, or Gemini with your own key).
- **Weather**: [Open-Meteo](https://open-meteo.com); the city is the one you type in settings, or a rough one from your internet address ([ipwho.is](https://ipwho.is)).
- **Speed test**: Cloudflare. **Playing a song on Spotify**: a DuckDuckGo search for its link.
- **New versions**: once a day, GitHub's page of the latest release (nothing about you is sent).

Voice is transcribed on your computer (whisper.cpp). The visualizer listens to the sound output only while a player is on screen. The GNOME extension only talks to Lydia, over your session's D-Bus.

## License

Lydia is source-available, not open source: you may install her, read the code and change it for your own personal use, free of charge; you may not sell her, use her commercially or redistribute her (changed or not). See [LICENSE](LICENSE). Third-party parts keep their own licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Roadmap

See [ROADMAP.md](ROADMAP.md).
