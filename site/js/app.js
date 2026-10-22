/* =============================================
   LYDIA · site · app.js
   The opening veil, the nav, the demo island and Lydia in the hero, the
   talking scene, the copy buttons and the footer letters that change shape.
   Needs gsap (+ ScrollTrigger, SplitText, MorphSVGPlugin, CustomEase), Lenis,
   i18n.js and glyphs.js. Without them (or with reduced motion) the page is
   simply shown, still.
   ============================================= */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const touch = matchMedia('(hover: none)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = !!(window.gsap && window.ScrollTrigger && window.SplitText && window.MorphSVGPlugin && window.CustomEase) && !reduce;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* no storage */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (!motion) root.classList.remove('js');
  if (motion) {
    gsap.registerPlugin(ScrollTrigger, SplitText, MorphSVGPlugin, CustomEase);
    CustomEase.create('snap', 'M0,0 C0.26,-0.38 0.14,1.24 1,1'); // backs off a little, then snaps into place
  }

  /* ---------- Lydia, drawn as in the app's chat ---------- */
  let orbs = 0;
  function drawLydia(host) {
    const id = `g-orb-${++orbs}`;
    const eye = (x) => `<g transform="translate(${x} 50)"><g class="eye"><rect class="eye-dot" x="-7" y="-8.5" width="14" height="17" rx="7"/><path class="eye-happy" d="M-8 3 Q0 -8 8 3"/></g></g>`;
    host.innerHTML = `<svg viewBox="0 0 100 100"><defs><radialGradient id="${id}" cx="34%" cy="28%" r="82%"><stop offset="0" stop-color="#c9b6ff"/><stop offset=".34" stop-color="#8f63f7"/><stop offset=".74" stop-color="#6229d8"/><stop offset="1" stop-color="#3d1590"/></radialGradient></defs><g class="body"><circle cx="50" cy="50" r="44" fill="url(#${id})"/><g class="face">${eye(35)}${eye(65)}</g></g></svg>`;
    // she blinks now and then, like in the app
    const blink = () => {
      host.classList.add('blink');
      setTimeout(() => host.classList.remove('blink'), 140);
      setTimeout(blink, 2600 + Math.random() * 3800);
    };
    setTimeout(blink, 1500 + Math.random() * 2000);
  }
  // her eyes follow the pointer, a few pixels at most
  function lookAt(x, y) {
    $$('[data-lydia]').forEach((h) => {
      const r = h.getBoundingClientRect();
      if (!r.width) return;
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 400);
      const face = $('.face', h);
      if (face) face.style.transform = `translate(${((dx / d) * 6 * k).toFixed(2)}px, ${((dy / d) * 5 * k).toFixed(2)}px)`;
    });
  }
  const happy = (host, ms = 1600) => {
    host.classList.add('happy');
    clearTimeout(host._h);
    host._h = setTimeout(() => host.classList.remove('happy'), ms);
  };

  /* ---------- language ---------- */
  const I18N = window.LYDIA_I18N || {};
  const LANGS = ['en', 'pt', 'es'];
  const Lang = {
    value: 'en',
    detect() {
      const saved = store.get('lydia-lang');
      if (LANGS.includes(saved)) return saved;
      for (const l of navigator.languages || [navigator.language || 'en']) {
        const k = String(l).slice(0, 2).toLowerCase();
        if (LANGS.includes(k)) return k;
      }
      return 'en';
    },
    t(key, fallback) {
      return (this.value !== 'en' && I18N[this.value]?.[key]) ?? fallback;
    },
    apply() {
      const dict = I18N[this.value] || {};
      $$('[data-i18n]').forEach((el) => {
        if (el.dataset.en == null) el.dataset.en = el.innerHTML;
        const v = this.value === 'en' ? el.dataset.en : dict[el.dataset.i18n];
        if (v != null && el.innerHTML !== v) el.innerHTML = v;
      });
      $$('[data-i18n-attr]').forEach((el) => {
        el.dataset.i18nAttr.split(';').forEach((pair) => {
          const [attr, key] = pair.split(':');
          const keep = 'en' + attr.replace(/[^a-z]/gi, '');
          if (el.dataset[keep] == null) el.dataset[keep] = el.getAttribute(attr) || '';
          const v = this.value === 'en' ? el.dataset[keep] : dict[key];
          if (v != null) el.setAttribute(attr, v);
        });
      });
      const meta = $('meta[name="description"]');
      if (meta.dataset.en == null) meta.dataset.en = meta.content;
      meta.content = this.value === 'en' ? meta.dataset.en : dict['meta.description'] || meta.dataset.en;
      if (root.dataset.title == null) root.dataset.title = document.title;
      document.title = this.value === 'en' ? root.dataset.title : dict.title || root.dataset.title;
      $('.lang-btn span').textContent = this.value.toUpperCase();
    },
    set(l, rebuild = true) {
      if (rebuild) Page.destroy(); // the split lines go back first, or they'd bring the old text back
      this.value = l;
      store.set('lydia-lang', l);
      root.lang = l === 'pt' ? 'pt-BR' : l;
      this.apply();
      Clock.tick();
      if (rebuild) Page.rebuild();
    },
  };

  /* ---------- the date in the nav and the island's clock (the viewer's own) ---------- */
  const Clock = {
    tick() {
      const now = new Date();
      $$('.clock').forEach((c) => (c.textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(now)));
      $$('.date').forEach((d) => (d.textContent = new Intl.DateTimeFormat(Lang.value === 'pt' ? 'pt-BR' : Lang.value, { day: 'numeric', month: 'long', year: 'numeric' }).format(now)));
    },
    start() {
      this.tick();
      setInterval(() => this.tick(), 15000);
    },
  };

  /* ---------- smooth scroll ---------- */
  let lenis = null;
  function startLenis() {
    if (!motion || typeof Lenis === 'undefined') { root.style.scrollBehavior = 'smooth'; return; }
    lenis = new Lenis({ duration: 1.15, easing: (t) => 1 - Math.pow(1 - t, 4), smoothWheel: true, anchors: { offset: -90 } });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  /* ---------- the letters of "lydia" turn into things from her world ---------- */
  const SHAPES = (() => {
    const circle = (cx, cy, r) => `M${cx} ${cy - r} C${cx + r * 0.55} ${cy - r} ${cx + r} ${cy - r * 0.55} ${cx + r} ${cy} C${cx + r} ${cy + r * 0.55} ${cx + r * 0.55} ${cy + r} ${cx} ${cy + r} C${cx - r * 0.55} ${cy + r} ${cx - r} ${cy + r * 0.55} ${cx - r} ${cy} C${cx - r} ${cy - r * 0.55} ${cx - r * 0.55} ${cy - r} ${cx} ${cy - r} Z`;
    return [
      'M26 22 L74 22 C90 22 100 34 100 50 C100 66 90 78 74 78 L26 78 C10 78 0 66 0 50 C0 34 10 22 26 22 Z', // the closed island
      circle(50, 50, 48), // her body
      'M0 86 C0 34 22 6 50 6 C78 6 100 34 100 86 L74 86 C74 54 64 34 50 34 C36 34 26 54 26 86 Z', // a happy eye
      'M50 0 C54 30 70 46 100 50 C70 54 54 70 50 100 C46 70 30 54 0 50 C30 46 46 30 50 0 Z', // the sparkle
      'M0 0 L100 0 L100 62 C100 86 86 100 62 100 L38 100 C14 100 0 86 0 62 Z', // the open island
      'M30 0 L70 0 C86 0 100 14 100 30 L100 70 C100 86 86 100 70 100 L30 100 C14 100 0 86 0 70 L0 30 C0 14 14 0 30 0 Z', // a round button
    ];
  })();
  function fitShape(d, b) {
    let xy = 0;
    return d.match(/[A-Za-z]|-?\d*\.?\d+/g).map((tok) => {
      if (/[A-Za-z]/.test(tok)) { xy = 0; return tok; }
      const v = parseFloat(tok);
      return ' ' + (xy++ % 2 === 0 ? b.x + (v / 100) * b.width : b.y + (v / 100) * b.height).toFixed(1);
    }).join('');
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function glyphSvg(host) {
    const data = window.LYDIA_GLYPHS;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', data.viewBox);
    svg.setAttribute('aria-hidden', 'true');
    host.append(svg);
    const items = data.letters.map((l, n) => {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', l.d);
      p.setAttribute('class', 'glyph');
      svg.append(p);
      return { p, d: l.d, k: (n * 2) % SHAPES.length };
    });
    items.forEach((it) => {
      const b = it.p.getBBox();
      const h = Math.max(b.height, 560);
      it.bbox = b;
      it.box = { x: b.x, y: b.y + b.height - h, width: b.width, height: h };
    });
    return { svg, items, vb: data.viewBox.split(' ').map(Number) };
  }

  /* ---------- the veil: "lydia" forms, then the page rises from under it ---------- */
  const Veil = {
    el: $('.veil'),
    clip(p) {
      const W = innerWidth, H = innerHeight;
      const yl = H * p;
      const yr = H * Math.max(0, Math.min(1, p * 1.12 - 0.12));
      const b = H * 0.24 * Math.sin(Math.PI * p);
      return `path('M0 0 H${W} V${yr} C${W * 0.7} ${yr + b} ${W * 0.3} ${yl + b * 0.55} 0 ${yl} Z')`;
    },
    async run() {
      const stage = $('.veil__stage', this.el);
      const count = $('.veil__count', this.el);
      stage.innerHTML = '<div class="veil__word"></div>';
      const { svg, items, vb } = glyphSvg($('.veil__word', stage));
      const ratio = vb[2] / vb[3];
      const h = Math.min(innerWidth * 0.18, 190, (innerWidth * 0.8) / ratio);
      svg.style.height = `${h}px`;
      svg.style.width = `${h * ratio}px`;
      const seed = Math.floor(Math.random() * SHAPES.length);
      items.forEach((it, i) => it.p.setAttribute('d', fitShape(SHAPES[(i + seed) % SHAPES.length], it.box)));
      const tl = gsap.timeline();
      items.forEach((it, i) => {
        tl.to(it.p, { morphSVG: fitShape(SHAPES[(i + seed + 3) % SHAPES.length], it.box), duration: 0.22, ease: 'snap' }, i * 0.06 + 0.22);
        tl.to(it.p, { morphSVG: it.d, duration: 0.45, ease: 'snap' }, i * 0.06 + 0.5);
      });
      const c = { v: 0 };
      tl.to(c, { v: 100, duration: tl.duration(), ease: 'power1.inOut', onUpdate: () => (count.textContent = String(Math.round(c.v)).padStart(3, '0')) }, 0);
      await tl.then();
      await sleep(150);
      const p = { v: 1 };
      await gsap.timeline()
        .to(stage, { yPercent: -40, opacity: 0, duration: 0.9, ease: 'power3.in' }, 0)
        .to(p, { v: 0, duration: 1.05, ease: 'power3.inOut', onUpdate: () => (this.el.style.clipPath = this.clip(p.v)) }, 0.1)
        .then();
      this.drop();
    },
    drop() { this.el.classList.remove('is-on'); this.el.style.clipPath = ''; },
  };

  /* ---------- nav ---------- */
  function navSpy() {
    const marks = ['top', 'features', 'voice', 'privacy', 'install'];
    const spy = () => {
      const line = innerHeight * 0.4;
      let now = 'top';
      for (const key of marks) {
        const el = $(`[data-section="${key}"]`);
        if (el && el.getBoundingClientRect().top <= line) now = key;
      }
      $$('.nav__links a').forEach((a) => a.classList.toggle('is-active', a.dataset.spy === now));
    };
    if (lenis) lenis.on('scroll', spy);
    else addEventListener('scroll', spy, { passive: true });
    spy();
  }
  // the name in the nav: each pass does a different little thing
  function wordHover() {
    const word = $('.word');
    word.innerHTML = [...word.textContent].map((c) => `<span class="ch">${c}</span>`).join('');
    if (!motion) return;
    const chars = $$('.ch', word);
    let i = 0, busy = false;
    const variants = [
      () => gsap.timeline().to(chars, { yPercent: -35, duration: 0.2, ease: 'power2.out', stagger: 0.04 }).to(chars, { yPercent: 0, duration: 0.5, ease: 'bounce.out', stagger: 0.04 }, 0.18),
      () => gsap.timeline().to(chars, { rotateX: 360, duration: 0.7, ease: 'power3.inOut', stagger: { each: 0.05, from: 'center' } }).set(chars, { rotateX: 0 }),
      () => gsap.timeline().to(chars, { color: '#8f63f7', duration: 0.15, stagger: 0.05 }).to(chars, { color: '', duration: 0.4, stagger: 0.05 }, 0.35),
    ];
    word.addEventListener('mouseenter', () => {
      if (busy) return;
      busy = true;
      variants[i++ % variants.length]().eventCallback('onComplete', () => (busy = false));
    });
  }
  function drawer() {
    const btn = $('.burger');
    const d = $('.drawer');
    let open = false;
    const set = (v) => {
      open = v;
      btn.setAttribute('aria-expanded', String(v));
      if (!motion) { d.style.visibility = v ? 'visible' : 'hidden'; d.style.clipPath = v ? 'none' : ''; return; }
      if (v) {
        lenis && lenis.stop();
        gsap.set(d, { visibility: 'visible' });
        gsap.timeline().to(d, { clipPath: 'inset(0 0 0% 0)', duration: 0.7, ease: 'power4.inOut' }).from($$('a', d), { yPercent: 60, opacity: 0, duration: 0.6, ease: 'expo.out', stagger: 0.05 }, 0.3);
      } else {
        lenis && lenis.start();
        gsap.to(d, { clipPath: 'inset(0 0 100% 0)', duration: 0.5, ease: 'power4.inOut', onComplete: () => gsap.set(d, { visibility: 'hidden' }) });
      }
    };
    btn.addEventListener('click', () => set(!open));
    $$('a', d).forEach((a) => a.addEventListener('click', () => set(false)));
    addEventListener('keydown', (e) => e.key === 'Escape' && open && set(false));
  }

  /* ---------- a cursor with a word ---------- */
  const Cursor = {
    active: null,
    init() {
      if (touch || !motion) return;
      const el = $('.cursor');
      this.label = $('.cursor__label', el);
      this.text = $('.cursor__text', el);
      const xTo = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3' });
      const yTo = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3' });
      let px = -1, py = -1;
      const sync = () => {
        const t = px < 0 ? null : document.elementFromPoint(px, py)?.closest('[data-cursor]') ?? null;
        if (t === this.active) return;
        this.active = t;
        if (t) this.say(t.dataset.cursor);
        gsap.to(this.label, t ? { scale: 1, duration: 0.45, ease: 'back.out(2)', overwrite: true } : { scale: 0, duration: 0.25, ease: 'power2.in', overwrite: true }); // overwrite: a fast pass must not leave it open
      };
      addEventListener('pointermove', (e) => { px = e.clientX; py = e.clientY; xTo(px); yTo(py); sync(); lookAt(px, py); });
      addEventListener('scroll', sync, { passive: true });
      if (lenis) lenis.on('scroll', sync);
      document.addEventListener('mouseleave', () => { px = -1; sync(); });
    },
    say(key) { if (this.text) this.text.textContent = Lang.t('cursor.' + key, key); },
  };

  /* =============================================
     THE PAGE (built again when the language changes)
     ============================================= */
  const Page = {
    ctx: null,
    cleanups: [],
    heroGo: false,
    heroAnims: [],
    build() {
      if (!motion) return;
      this.cleanups = [];
      this.heroAnims = [];
      this.ctx = gsap.context(() => {
        M.split();
        M.fade();
        M.counts();
        M.hero();
        M.tiles();
        M.talk();
        M.footer();
      });
      ScrollTrigger.refresh();
    },
    destroy() {
      this.cleanups.forEach((f) => f());
      this.cleanups = [];
      if (this.demo) this.demo.alive = false;
      this.ctx && this.ctx.revert();
      this.ctx = null;
    },
    rebuild() { if (motion) { this.heroGo = true; this.build(); } },
    go() { this.heroGo = true; this.heroAnims.forEach((a) => a.play()); },
  };

  const M = {
    // lines rise from behind a mask
    split() {
      $$('[data-split]').forEach((el) => {
        const hero = !!el.closest('.hero');
        SplitText.create(el, {
          type: 'lines', mask: 'lines', linesClass: 'line', autoSplit: true,
          onSplit(self) {
            el.classList.add('is-split');
            const anim = gsap.from(self.lines, { yPercent: 115, duration: 1.15, ease: 'expo.out', stagger: 0.08, paused: hero && !Page.heroGo, scrollTrigger: hero ? undefined : { trigger: el, start: 'top 88%', once: true } });
            if (hero) Page.heroAnims.push(anim);
            return anim;
          },
        });
      });
    },
    fade() {
      $$('[data-fade]').forEach((el) => {
        const hero = !!el.closest('.hero');
        const anim = gsap.to(el, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', delay: hero ? 0.3 : 0, paused: hero && !Page.heroGo, scrollTrigger: hero ? undefined : { trigger: el, start: 'top 92%', once: true } });
        if (hero) Page.heroAnims.push(anim);
      });
    },
    counts() {
      $$('[data-count]').forEach((el) => {
        const end = Number(el.dataset.count);
        if (!end) return;
        const hero = !!el.closest('.hero');
        const o = { v: 0 };
        el.textContent = '0';
        const anim = gsap.to(o, { v: end, duration: 1.6, ease: 'power3.out', delay: hero ? 0.8 : 0, paused: hero && !Page.heroGo, onUpdate: () => (el.textContent = String(Math.round(o.v))), scrollTrigger: hero ? undefined : { trigger: el, start: 'top 92%', once: true } });
        if (hero) Page.heroAnims.push(anim);
      });
    },

    // the violet block: comes up, the island opens and goes through its tabs, Lydia watches
    hero() {
      const stage = $('[data-stage]');
      Page.heroAnims.push(gsap.from(stage, { clipPath: `inset(100% 0% 0% 0% round 40px)`, duration: 1.4, ease: 'expo.inOut', paused: !Page.heroGo, onComplete: () => stage.style.removeProperty('clip-path') }));
      Page.heroAnims.push(gsap.from($$('.cut', stage), { scale: 0, duration: 0.9, ease: 'back.out(1.6)', stagger: 0.12, delay: 0.8, paused: !Page.heroGo }));
      Page.heroAnims.push(gsap.from($('.lydia--hero', stage), { yPercent: 60, opacity: 0, duration: 1.2, ease: 'expo.out', delay: 0.9, paused: !Page.heroGo }));
      const demo = (Page.demo = Demo.create(stage));
      const start = gsap.delayedCall(1.4, () => demo.start());
      start.pause();
      Page.heroAnims.push(start);
    },

    // feature blocks come up one after another
    tiles() {
      $$('.tile').forEach((t, i) => gsap.from($('.tile__shot', t), { yPercent: -30, opacity: 0, duration: 1.2, ease: 'expo.out', delay: (i % 3) * 0.08, scrollTrigger: { trigger: t, start: 'top 85%', once: true } }));
    },

    // a short exchange on loop while the block is on screen
    talk() {
      const el = $('[data-talk]');
      const her = $('[data-lydia]', el);
      const [me, reply] = $$('.bubble', el);
      gsap.set([me, reply], { opacity: 0, y: 14 });
      const scene = gsap.timeline({ repeat: -1, repeatDelay: 1.2, paused: true })
        .to(me, { opacity: 1, y: 0, duration: 0.7, ease: 'expo.out' }, 0.4)
        .call(() => happy(her, 2600), null, 2.2)
        .to(reply, { opacity: 1, y: 0, duration: 0.7, ease: 'expo.out' }, 2.2)
        .to([me, reply], { opacity: 0, y: -10, duration: 0.5, ease: 'power2.in' }, 5.6);
      ScrollTrigger.create({ trigger: el, start: 'top 85%', end: 'bottom top', onToggle: (s) => (s.isActive ? scene.play() : scene.pause()) });
    },

    // the big "lydia" at the bottom: each letter becomes another shape under the mouse
    footer() {
      const host = $('.footer__mark');
      if (!window.LYDIA_GLYPHS) return;
      host.innerHTML = '';
      const { svg, items, vb } = glyphSvg(host);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'lydia');
      const [vx, vy, vw, vh] = vb;
      items.forEach((it, n) => {
        const b = it.bbox;
        const prev = items[n - 1]?.bbox, next = items[n + 1]?.bbox;
        const left = prev ? (prev.x + prev.width + b.x) / 2 : vx;
        const right = next ? (b.x + b.width + next.x) / 2 : vx + vw;
        const r = document.createElementNS(SVGNS, 'rect');
        Object.entries({ x: left, y: vy, width: right - left, height: vh, class: 'hit' }).forEach(([k, v]) => r.setAttribute(k, v));
        svg.append(r);
        const enter = () => gsap.to(it.p, { morphSVG: fitShape(SHAPES[it.k], it.box), duration: 0.32, ease: 'snap', overwrite: true });
        const leave = () => { gsap.to(it.p, { morphSVG: it.d, duration: 0.32, ease: 'snap', overwrite: true }); it.k = (it.k + 1) % SHAPES.length; };
        if (touch) r.addEventListener('pointerdown', () => { enter(); setTimeout(leave, 650); });
        else { r.addEventListener('mouseenter', enter); r.addEventListener('mouseleave', leave); }
      });
      gsap.from(items.map((i) => i.p), { yPercent: 60, opacity: 0, duration: 1.1, ease: 'expo.out', stagger: 0.06, scrollTrigger: { trigger: host, start: 'top 95%' } });
    },
  };

  /* ---------- the demo island ---------- */
  const Demo = {
    create(stage) {
      const win = $('.demo__win', stage);
      const pill = $('.demo__pill', stage);
      const shots = $$('[data-shot]', win);
      const thumbs = $$('[data-thumb]', stage);
      const lydia = $('.lydia--hero', stage);
      const demo = { alive: true, i: 0, opened: false };
      shots.forEach((im) => { im.style.width = `${(Number(im.getAttribute('width')) / 840) * 100}%`; im.classList.remove('is-on'); gsap.set(im, { opacity: 0 }); });
      shots[0].classList.add('is-on');
      gsap.set(shots[0], { opacity: 1 });
      const thumbsFor = (i) => thumbs.forEach((t, k) => { const n = (i + 1 + k) % shots.length; $('img', t).src = shots[n].src; t.dataset.to = n; });
      thumbsFor(0);
      const show = (n) => {
        if (n === demo.i) return;
        const from = shots[demo.i], to = shots[n];
        demo.i = n;
        gsap.timeline()
          .to(from, { opacity: 0, y: -14, duration: 0.35, ease: 'power2.in', onComplete: () => from.classList.remove('is-on') })
          .fromTo(to, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7, ease: 'expo.out', onStart: () => to.classList.add('is-on') }, 0.2);
        thumbsFor(n);
      };
      const open = () => {
        demo.opened = true;
        return gsap.timeline().to(pill, { opacity: 0, duration: 0.3 }, 0).to(win, { clipPath: 'inset(-40px -40px -40px -40px round 0 0 40px 40px)', duration: 1.1, ease: 'expo.inOut' }, 0);
      };
      const close = () => {
        demo.opened = false;
        return gsap.timeline().to(win, { clipPath: 'inset(0px calc(50% - 105px) calc(100% - 40px) calc(50% - 105px) round 0 0 22px 22px)', duration: 0.9, ease: 'expo.inOut' }, 0).to(pill, { opacity: 1, duration: 0.4 }, 0.6);
      };
      let paused = false;
      const enter = () => (paused = true), leave = () => (paused = false);
      stage.addEventListener('pointerenter', enter);
      stage.addEventListener('pointerleave', leave);
      const pick = (n) => { if (!demo.opened) open(); show(n); happy(lydia, 1000); };
      const onThumb = (e) => pick(Number(e.currentTarget.dataset.to));
      const onNext = () => pick((demo.i + 1) % shots.length);
      thumbs.forEach((t) => t.addEventListener('click', onThumb));
      $('[data-next]', stage).addEventListener('click', onNext);
      Page.cleanups.push(() => {
        stage.removeEventListener('pointerenter', enter);
        stage.removeEventListener('pointerleave', leave);
        thumbs.forEach((t) => t.removeEventListener('click', onThumb));
        $('[data-next]', stage).removeEventListener('click', onNext);
      });
      // opens, shows each tab for a few seconds, closes to the pill, again
      demo.start = async () => {
        let visible = true;
        const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
        io.observe(stage);
        Page.cleanups.push(() => io.disconnect());
        const wait = async (ms) => { let t = 0; while (demo.alive && t < ms) { await sleep(100); if (!paused && visible && !document.hidden) t += 100; } };
        while (demo.alive) {
          await wait(800);
          if (!demo.alive) break;
          if (!demo.opened) { await open().then(); happy(lydia); }
          for (let k = 0; k < shots.length - 1 && demo.alive; k++) { await wait(3200); if (demo.alive) show((demo.i + 1) % shots.length); }
          await wait(3200);
          if (demo.alive) await close().then();
        }
      };
      return demo;
    },
  };

  /* ---------- copy buttons ---------- */
  function copyButtons() {
    $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      try { await navigator.clipboard.writeText(text); } catch (e) {
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.append(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (err) { /* nothing more to try */ }
        ta.remove();
      }
      btn.classList.add('is-copied');
      Cursor.say('copied');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.classList.remove('is-copied'); if (Cursor.active === btn) Cursor.say('copy'); }, 1600);
    }));
  }

  /* ---------- still page (no motion) ---------- */
  function stillPage() {
    $('.demo__win').style.clipPath = 'none';
    $('.demo__pill').style.display = 'none';
    $$('[data-shot]').forEach((s, i) => { s.style.width = `${(Number(s.getAttribute('width')) / 840) * 100}%`; s.style.display = i ? 'none' : ''; s.classList.toggle('is-on', !i); });
    $$('.bubble').forEach((b) => (b.style.opacity = 1));
  }

  /* ---------- go ---------- */
  function init() {
    $('.year').textContent = new Date().getFullYear();
    $$('[data-lydia]').forEach(drawLydia);
    $('.lang-btn').addEventListener('click', () => Lang.set(LANGS[(LANGS.indexOf(Lang.value) + 1) % LANGS.length]));
    Lang.set(Lang.detect(), false);
    Clock.start();
    copyButtons();
    drawer();
    wordHover();
    if (!motion) {
      stillPage();
      navSpy();
      if (!touch) addEventListener('pointermove', (e) => lookAt(e.clientX, e.clientY));
      return;
    }
    startLenis();
    navSpy();
    Cursor.init();
    if (touch) addEventListener('pointermove', (e) => lookAt(e.clientX, e.clientY));
    Page.build();

    const seen = store.get('lydia-seen') === '1';
    const enter = () => { gsap.from('.nav', { yPercent: -150, duration: 1.1, ease: 'expo.out' }); Page.go(); };
    const run = () => {
      if (seen || !window.LYDIA_GLYPHS) { Veil.drop(); enter(); return; }
      Veil.run().then(() => { store.set('lydia-seen', '1'); enter(); });
    };
    (document.fonts?.ready ?? Promise.resolve()).then(run);
    // layout settles as fonts and images land: the scroll triggers follow
    let h = document.body.scrollHeight, t = 0;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (Math.abs(document.body.scrollHeight - h) > 4) { h = document.body.scrollHeight; ScrollTrigger.refresh(); } }, 200);
    }).observe(document.body);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
