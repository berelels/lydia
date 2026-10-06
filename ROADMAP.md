# Lydia: roadmap

Objetivo: ela rodar bem na máquina de qualquer pessoa, instalar em um clique e
ser fácil de descobrir. Em ordem de impacto.

## 1. Rodar na máquina das pessoas
- [x] Sensores além de AMD: Intel (coretemp, xe/i915), NVIDIA (nouveau e nvidia-smi), APU + placa, zonas térmicas. Testes em `test/sensors.test.js`.
- [x] Desktop em "backends" (`app/desktop/`): X11 (xprop/xdotool, como hoje), GNOME (extensão do Shell, funciona em X11 e Wayland) e "nenhum" (sem detectar janelas, mas o resto funciona).
- [x] Extensão do GNOME Shell (`gnome-extension/`): ponteiro, tela cheia, janela sob a pill, janela ativa, por D-Bus.
- [x] Testar em Wayland (gnome-shell aninhado): pill, alça, tela cheia com janela nativa Wayland, foco do chat. Falta: hover com o mouse de verdade.
- [x] Em Wayland ela se reabre por XWayland (`--ozone-platform=x11`), que pode se posicionar no topo.
- [ ] KDE Plasma (script do KWin ou layer-shell).
- [x] Não quebrar sozinha: sem `xprop`, `xdotool`, `python3` ou sensores, avisar uma vez e seguir.

## 2. Instalar em um clique
- [ ] AppImage e .deb (electron-builder), depois Flatpak (Flathub).
- [ ] Ícone e entrada no menu de aplicativos. (Iniciar com o sistema: já no assistente.)
- [x] Assistente de configuração (primeira execução e menu): idioma, chat padrão (login do Claude, chave do Gemini, modelo do Ollama), hooks do Claude Code com diff, extensão do GNOME, preferências e iniciar com o sistema.

## 3. Alguém descobrir que ela existe
- [ ] README com GIF/vídeo: a pill abrindo, alertas, chat, Code.
- [ ] Licença (MIT ou GPL, decisão do autor) e `CONTRIBUTING.md`.
- [ ] Página simples (GitHub Pages) e posts (r/linux, r/unixporn, Hacker News).

## 4. Confiança
- [x] Testes com `npm test` (node:test, sem dependências).
- [ ] CI (GitHub Actions) rodando os testes.
- [x] Instalar os hooks do Claude Code pela UI, mostrando o diff e pedindo confirmação (com testes).
