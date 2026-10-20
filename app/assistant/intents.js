/**
 * Everyday commands understood with plain rules, offline and instantly, in
 * Portuguese, English and Spanish: "volume 30", "abre o YouTube", "pausa a
 * música". Anything else goes to the language model (brain.js).
 *
 * parse(text) -> { tool, args } | null
 */

/** Lowercase, no accents, no punctuation, no "Lydia," or "por favor". */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,!?¿¡;:"“”]/g, ' ')
    .replace(/\b(lydia|lidia|ei|hey|oi|ola|hola|por favor|please|pf|pfv|porfa)\b/g, ' ')
    .replace(/\b(pode|poderia|voce pode|can you|could you|puedes|podrias)\b/g, ' ')
    .replace(/\b(pra mim|para mim|for me|para mi|pra gente)\b/g, ' ') // "abre o spotify pra mim"
    .replace(/\s+(agora|ai|ja|now|ahora|rapidinho)\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUM_WORDS = {
  zero: 0, dez: 10, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100,
  ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta_es: 70, ochenta: 80, noventa_es: 90, cien: 100,
  um: 1, uma: 1, one: 1, uno: 1, dois: 2, duas: 2, two: 2, dos: 2, tres: 3, three: 3, cinco: 5, five: 5,
};
/** "30", "trinta", "metade" -> a number, or null. */
function number(word) {
  if (word == null) return null;
  if (/^\d+$/.test(word)) return Number(word);
  if (/^(metade|meio|half|mitad)$/.test(word)) return 50;
  if (/^(maximo|max|maximum|tope)$/.test(word)) return 100;
  if (/^(minimo|min|minimum)$/.test(word)) return 5;
  return NUM_WORDS[word] ?? null;
}

/** "uma música do AC/DC" -> "ac/dc"; "a playlist de rock" stays (Spotify finds playlists). */
function musicQuery(s) {
  return s
    .replace(/^(?:uma |umas |a |as |o |os |alguma |algo |something |some |a song |songs |una |unas |la |las |el |los |algo de )?(?:musica|musicas|cancion|canciones|song|songs|som|sons)?\s*(?:do|da|dos|das|de|by|of|del)?\s*/, '')
    .trim();
}

const SECONDS = { s: 1, seg: 1, segundo: 1, segundos: 1, second: 1, seconds: 1, sec: 1, min: 60, minuto: 60, minutos: 60, minute: 60, minutes: 60, h: 3600, hora: 3600, horas: 3600, hour: 3600, hours: 3600 };

const RULES = [
  // ---- volume ----
  [/\b(?:volume|som|sound|audio|sonido)\b.*?\b(\d{1,3}|\w+)\s*(?:%|por ?cento|percent|porciento)?$/, (m) => {
    const n = number(m[1]);
    return n == null ? null : { tool: 'set_volume', args: { level: Math.min(100, n) } };
  }],
  [/\b(?:aumenta|aumentar|sobe|subir|mais alto|aumente|turn (?:it )?up|louder|volume up|sube|subir el)\b/, () => ({ tool: 'change_volume', args: { delta: 10 } })],
  [/\b(?:abaixa|abaixar|diminui|diminuir|baixa|mais baixo|abaixe|diminua|turn (?:it )?down|quieter|volume down|baja|bajar)\b/, () => ({ tool: 'change_volume', args: { delta: -10 } })],
  [/\b(?:desmuta|desmutar|tira do mudo|volta o som|ativa o som|liga o som|unmute|quita el silencio|activa el sonido)\b/, () => ({ tool: 'mute', args: { on: false } })],
  [/\b(?:muta|mutar|silencia|silenciar|mudo|tira o som|desliga o som|mute|silencio)\b/, () => ({ tool: 'mute', args: { on: true } })],

  // ---- media ----
  [/\b(?:proxima|proximo|pula|pular|passa|next|skip|siguiente|salta)\b/, () => ({ tool: 'media', args: { action: 'next' } })],
  [/\b(?:anterior|volta a musica|musica anterior|previous|go back|atras)\b/, () => ({ tool: 'media', args: { action: 'previous' } })],
  [/^(?:pausa|pausar|pause|para a musica|para o video|pare|stop|deten|para la musica)\b/, () => ({ tool: 'media', args: { action: 'pause' } })],
  [/^(?:continua|continuar|despausa|play|resume|retoma|sigue|reanuda|toca)$/, () => ({ tool: 'media', args: { action: 'play' } })],

  // ---- music: "toca AC/DC no Spotify", "toca Back in Black" ----
  [/^(?:toca|tocar|coloca|poe|bota|play|pon|reproduce|quero ouvir|i want to hear|quiero escuchar)\s+(.+?)\s+(?:no|on|en)\s+(?:o\s+)?spotify$/, (m) => ({ tool: 'play_music', args: { query: musicQuery(m[1]), app: 'spotify' } })],
  [/^(?:toca|tocar|coloca|poe|bota|play|pon|reproduce|quero ouvir|i want to hear|quiero escuchar)\s+(?!.*\b(?:no|on|en)\s+(?:o\s+)?youtube$)(.+?)(?:\s+(?:pra|para) tocar)?$/, (m) => {
    const q = musicQuery(m[1]);
    return q ? { tool: 'play_music', args: { query: q, app: '' } } : null;
  }],
  [/^(?:coloca|poe|bota)\s+(.+?)\s+(?:pra|para) tocar$/, (m) => ({ tool: 'play_music', args: { query: musicQuery(m[1]), app: '' } })],

  // ---- YouTube / search ----
  [/^(?:toca|tocar|coloca|poe|bota|play|pon|reproduce)\s+(.+?)\s+(?:no|on|en)\s+(?:o\s+)?youtube$/, (m) => ({ tool: 'youtube_search', args: { query: m[1] } })],
  [/^(?:pesquisa|pesquisar|procura|procurar|busca|buscar|search(?: for)?|look up|google)\s+(?:por\s+|sobre\s+|for\s+)?(.+?)\s+(?:no|on|en)\s+(?:o\s+)?youtube$/, (m) => ({ tool: 'youtube_search', args: { query: m[1] } })],
  [/^(?:pesquisa|pesquisar|procura|procurar|busca|buscar|search(?: for)?|look up|google|googla)\s+(?:por\s+|sobre\s+|for\s+)?(.+?)(?:\s+(?:no|on|en)\s+(?:o\s+)?google)?$/, (m) => ({ tool: 'web_search', args: { query: m[1] } })],

  // ---- open ----
  [/^(?:abre|abrir|abra|abri|open|launch|start|inicia|iniciar|executa|roda|abre me)\s+(?:o\s+|a\s+|os\s+|as\s+|the\s+|el\s+|la\s+)?(.+?)(?:\s+(?:no|in|en)\s+(?:o\s+)?(?:navegador|browser))?$/, (m, text) => {
    const target = m[1].trim();
    if (!target) return null;
    return { tool: 'open', args: { target, web: /\b(navegador|browser)\b/.test(text) } };
  }],
  [/^(?:fecha|fechar|feche|close|quit|cierra|cerrar|encerra|encerrar)\s+(?:o\s+|a\s+|the\s+|el\s+|la\s+)?(.+)$/, (m) => ({ tool: 'close_app', args: { name: m[1].trim() } })],

  // ---- time, timers ----
  [/\b(?:que horas|quantas horas|what time|que hora)\b/, () => ({ tool: 'time_now', args: {} })],
  [/\b(?:timer|temporizador|cronometro|alarme|me avisa|me lembra|avisa|remind me|set a timer|alarma|avisame)\b.*?\b(\d+|\w+)\s*(segundos?|seg|s|minutos?|min|horas?|h|seconds?|sec|minutes?|hours?)\b/, (m) => {
    const n = number(m[1]);
    return n == null ? null : { tool: 'timer', args: { seconds: n * SECONDS[m[2]] } };
  }],

  // ---- system ----
  [/\b(?:bloqueia|bloquear|tranca|trancar)\b.*\b(?:tela|pc|computador)\b|\block (?:the )?(?:screen|pc|computer)\b|\bbloquea(?:r)? (?:la )?pantalla\b/, () => ({ tool: 'lock_screen', args: {} })],
  [/\b(?:modo|tema|mode|theme)\s+(escuro|dark|oscuro)\b|\b(dark) mode\b/, () => ({ tool: 'set_theme', args: { dark: true } })],
  [/\b(?:modo|tema|mode|theme)\s+(claro|light)\b|\b(light) mode\b/, () => ({ tool: 'set_theme', args: { dark: false } })],
  [/\b(?:como (?:esta|ta) (?:o )?(?:pc|computador|sistema)|status do (?:pc|sistema)|uso de (?:ram|cpu|memoria)|how(?:'s| is) (?:my |the )?(?:pc|computer|system)|como esta (?:el )?(?:pc|ordenador|sistema))\b/, () => ({ tool: 'system_status', args: {} })],
];

/** The command in `text`, or null when it isn't one of the everyday ones. */
function parse(text) {
  const t = normalize(text);
  if (!t) return null;
  for (const [re, make] of RULES) {
    const m = re.exec(t);
    if (!m) continue;
    const r = make(m, t);
    if (r) return r;
  }
  return null;
}

module.exports = { parse, normalize, number };
