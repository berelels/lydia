# Lydia: roadmap

Objetivo: rodar bem na máquina de qualquer pessoa, instalar em um clique e ser
fácil de descobrir. Em ordem de impacto.

## Feito
- [x] Ilha no topo: barra fechada com relógio e/ou números do sistema, alça sobre janelas maximizadas, notch em tela cheia, player quando algo toca.
- [x] Abas: Controles (Wi-Fi, Bluetooth com listas, luz noturna, não perturbe, modo escuro, saída e entrada de som, brilho, player), Hoje (relógio, clima, semana, timer, tarefas), Sistema, Área de transferência, Apps, Papel de parede, Chat, Notificações, Energia, Configurações.
- [x] Voz (Gemini ou Kokoro), conversa contínua, ditado, comandos offline em pt/en/es.
- [x] Extensão do GNOME: ponteiro, tela cheia, janela sob a ilha, esconder a barra do GNOME, tecla Super, notificações, ajuste das janelas encaixadas.
- [x] Assistente de configuração, três idiomas, fonte e cor de destaque.
- [x] Testes com `npm test` (node:test, sem dependências).

## 1. Lançar para Ubuntu 24.04+ com GNOME
- [x] `.deb` com electron-builder (`npm run dist`): ícone, entrada no menu, `/usr/bin/lydia`.
- [x] Scripts Python e extensão do GNOME fora do asar (`app/paths.js`).
- [x] Dependências do `.deb` (e recomendados: bluez, network-manager, wireplumber, pipewire-bin, ferramentas da voz).
- [x] Perfil AppArmor do Ubuntu 24.04 instalado pelo pós-instalação do `.deb`.
- [ ] Testar a instalação num Ubuntu 24.04 limpo (máquina virtual).
- [x] AppImage, `.rpm` e `.deb` para x64 e arm64, gerados no GitHub Actions (sem `--no-sandbox` manual no Ubuntu 24.04).
- [ ] Voz sem compilar na máquina: baixar o whisper.cpp pronto; `python3-venv` para o Kokoro.
- [ ] Embutir a fonte Inter (OFL).
- [x] Ícones pelo tema atual (GNOME, Cinnamon, MATE, XFCE, KDE), com os temas herdados.
- [ ] Licença, créditos de terceiros (Kokoro, whisper.cpp, Inter) e política de privacidade.
- [ ] Atualizações: repositório APT assinado ou atualização do AppImage.

## 2. Ubuntu 22.04 e derivadas
- [x] Áudio pelo PulseAudio quando não houver PipeWire (`app/audio.js`).
- [x] Extensão para GNOME 45–51 (`is_maximized` do 49+); o assistente avisa no GNOME 42–44 e oferece atualizar a extensão.
- [ ] Extensão no formato do GNOME 42–44.

## 3. Outros desktops
- [x] Cinnamon, KDE, XFCE, MATE: papel de parede, sair da sessão, configurações do sistema.
- [ ] Nesses desktops: modo escuro, luz noturna, não perturbe, áreas de trabalho.
- [ ] KDE Plasma no Wayland (script do KWin ou layer-shell).

## 4. Confiança e alcance
- [x] CI (GitHub Actions): testes e pacotes.
- [ ] Testar: Ubuntu 24.04 (Wayland), 22.04, Mint 22, Kubuntu, Pop!_OS 24.04 (COSMIC), vários monitores, escala de tela, Wi-Fi de verdade.
- [ ] Palavra de ativação ("Oi Lydia").
- [ ] Página simples (GitHub Pages) e posts.
