'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const countNL = s => { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; };
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), typeof ms === 'function' ? ms() : ms); }; d.cancel = () => clearTimeout(t); return d; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const stripExt = n => n.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');

  // ---------- Elements (cached once; preview headings may reuse ids) ----------
  const el = {
    body: document.body, root: document.documentElement,
    workspace: $('#workspace'), editorPane: $('#editor-pane'), previewPane: $('#preview-pane'),
    preview: $('#preview'), resizer: $('#resizer'), sidebar: $('#sidebar'),
    docList: $('#doc-list'), docSearch: $('#doc-search'), outline: $('#outline'),
    title: $('#doc-title'), dirtyDot: $('#dirty-dot'),
    stPos: $('#st-pos'), stSel: $('#st-sel'), stWords: $('#st-words'), stChars: $('#st-chars'), stRead: $('#st-read'), stSave: $('#st-save'),
    findbar: $('#findbar'), findInput: $('#find-input'), replaceInput: $('#replace-input'), findCount: $('#find-count'),
    findCase: $('#find-case'), findWord: $('#find-word'), findRegex: $('#find-regex'),
    settingsDlg: $('#settings-dlg'), helpDlg: $('#help-dlg'), dropzone: $('#dropzone'), toast: $('#toast'),
    fileInput: $('#file-input'), syncBtn: $('#sync-btn'), themeBtn: $('#theme-btn'),
    hljsLight: $('#hljs-light'), hljsDark: $('#hljs-dark'), welcome: $('#welcome-md'),
  };

  // ---------- Settings ----------
  const DEFAULTS = {
    theme: 'auto', previewStyle: 'github', editorFont: 'mono', fontSize: 15, previewFontSize: 16,
    previewWidth: 'normal', tabSize: 2, lineNumbers: false, lineWrapping: true, spellcheck: false,
    syncScroll: true, autoPairs: true, typewriter: false, math: true, mathToolbar: true, mathTab: 'struct', mermaid: true, breaks: false,
    mode: 'split', split: 50, sidebar: true, sideTab: 'docs',
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  let settings = { ...DEFAULTS, ...store.get('mde.settings', {}) };
  const saveSettings = () => store.set('mde.settings', settings);

  const FONTS = {
    mono: 'ui-monospace, "JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    sans: 'system-ui, -apple-system, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
    serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Noto Serif", serif',
  };

  // ---------- IndexedDB document store ----------
  // File handles live in their own store and are written only when the user opens or saves a
  // file. Re-serializing a handle while a tab is hiding/closing crashed Chromium 154 (dangling
  // raw_ptr check) when a duplicated editor tab was closed.
  const db = (() => {
    let p;
    const open = () => p ||= new Promise((res, rej) => {
      const r = indexedDB.open('markdown-editor', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('handles')) d.createObjectStore('handles');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = async (stores, mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(stores, mode);
        const r = fn(t);
        t.oncomplete = () => res(r && r.result);
        t.onerror = () => rej(t.error);
      });
    };
    const strip = ({ handle, ...rest }) => rest;
    return {
      all: () => tx('docs', 'readonly', t => t.objectStore('docs').getAll()),
      async allHandles() {
        const out = new Map();
        await tx('handles', 'readonly', t => {
          t.objectStore('handles').openCursor().onsuccess = e => {
            const c = e.target.result;
            if (c) { out.set(c.key, c.value); c.continue(); }
          };
        });
        return out;
      },
      put: doc => tx('docs', 'readwrite', t => t.objectStore('docs').put(strip(doc))),
      putHandle: (id, h) => tx('handles', 'readwrite', t => t.objectStore('handles').put(h, id)),
      del: id => tx(['docs', 'handles'], 'readwrite', t => { t.objectStore('docs').delete(id); t.objectStore('handles').delete(id); }),
    };
  })();

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  // =====================================================================
  // Markdown rendering
  // =====================================================================
  let ctx = null; // per-render state
  const slugify = s => s.toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-') || 'section';
  function uniqueSlug(raw) {
    const base = slugify(raw);
    const n = ctx.slugs.get(base) || 0;
    ctx.slugs.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  }
  const fnId = label => label.replace(/[^\w-]/g, '_');

  function renderMath(tex, display) {
    if (!window.katex) return `<code>${esc(tex)}</code>`;
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
    } catch (e) {
      return `<span class="math-error">${esc(e.message)}</span>`;
    }
  }

  // Calls cb(line, index) for every line not inside a fenced code block.
  function eachProseLine(text, cb, startLine = 0) {
    const lines = text.split('\n');
    let fence = null;
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i];
      const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(l);
      if (f) {
        if (!fence) { fence = f[1]; continue; }
        if (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) { fence = null; continue; }
      }
      if (!fence) cb(l, i, lines);
    }
    return lines;
  }

  // Pull footnote definitions out of the text (blanking their lines so line numbers stay intact).
  function extractFootnotes(text) {
    if (!/^\[\^[^\]\n]+\]:/m.test(text)) return text;
    const blank = new Set();
    const lines = eachProseLine(text, (l, i, all) => {
      if (blank.has(i)) return;
      const m = /^\[\^([^\]\n]+)\]:[ \t]?(.*)$/.exec(l);
      if (!m) return;
      let body = m[2];
      blank.add(i);
      let j = i + 1;
      while (j < all.length && (/^( {2,}|\t)\S/.test(all[j]) || (all[j].trim() === '' && /^( {2,}|\t)\S/.test(all[j + 1] || '')))) {
        body += '\n' + all[j].replace(/^( {1,4}|\t)/, '');
        blank.add(j++);
      }
      if (!ctx.fnDefs.has(m[1])) ctx.fnDefs.set(m[1], body);
    });
    for (const i of blank) lines[i] = '';
    return lines.join('\n');
  }

  function renderFootnotes() {
    if (!ctx.fnOrder.length) return '';
    let html = '<section class="footnotes"><ol>';
    for (const label of ctx.fnOrder) {
      const id = fnId(label);
      const body = marked.parser(marked.lexer(ctx.fnDefs.get(label) || ''));
      const refs = ctx.fnRefCount[label] || 1;
      let back = '';
      for (let r = 1; r <= refs; r++) back += ` <a href="#fnref-${id}${r > 1 ? '-' + r : ''}" class="fn-back" aria-label="Back to reference">↩${r > 1 ? `<sup>${r}</sup>` : ''}</a>`;
      html += `<li id="fn-${id}">${body.trim()}${back}</li>`;
    }
    return html + '</ol></section>';
  }

  function renderFrontMatter(yaml) {
    const lines = yaml.split('\n').filter(l => l.trim());
    if (lines.length && lines.every(l => /^[\w.-]+\s*:/.test(l) || /^\s+/.test(l))) {
      const rows = [];
      for (const l of lines) {
        const m = /^([\w.-]+)\s*:\s*(.*)$/.exec(l);
        if (m) rows.push([m[1], m[2]]);
        else if (rows.length) rows[rows.length - 1][1] += (rows[rows.length - 1][1] ? '\n' : '') + l.trim();
      }
      return `<details class="frontmatter"><summary>Front matter</summary><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table></details>`;
    }
    return `<details class="frontmatter"><summary>Front matter</summary><pre><code>${esc(yaml)}</code></pre></details>`;
  }

  marked.use({
    gfm: true,
    renderer: {
      code(code, info) {
        const lang = (info || '').trim().split(/\s+/)[0].toLowerCase();
        if (lang === 'mermaid' && settings.mermaid) return `<div class="mermaid-block pending" data-src="${encodeURIComponent(code)}"></div>`;
        if ((lang === 'math' || lang === 'latex' || lang === 'katex') && settings.math) return `<div class="math-block">${renderMath(code, true)}</div>`;
        let html = null;
        if (lang && hljs.getLanguage(lang)) {
          try { html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { /* fall through */ }
        }
        if (html == null) html = esc(code);
        return `<pre><code class="hljs${lang ? ' language-' + esc(lang) : ''}">${html}</code>${lang ? `<span class="code-lang">${esc(lang)}</span>` : ''}<button class="copy-code" type="button">Copy</button></pre>\n`;
      },
      heading(text, level, raw) {
        const id = uniqueSlug(raw);
        return `<h${level} id="${esc(id)}"><a class="anchor" href="#${esc(id)}" aria-hidden="true">#</a>${text}</h${level}>\n`;
      },
      checkbox(checked) {
        return `<input type="checkbox" class="task"${checked ? ' checked' : ''}> `;
      },
    },
    extensions: [
      {
        name: 'mathBlock', level: 'block',
        start(src) { if (!settings.math) return; const m = /^\$\$/m.exec(src); return m ? m.index : undefined; },
        tokenizer(src) {
          if (!settings.math) return;
          const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n+|$)/.exec(src);
          if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
        },
        renderer(t) { return `<div class="math-block">${renderMath(t.text, true)}</div>\n`; },
      },
      {
        name: 'mathInline', level: 'inline',
        start(src) { if (!settings.math) return; const m = /(?<!\\)\$/.exec(src); return m ? m.index : undefined; },
        tokenizer(src) {
          if (!settings.math) return;
          // GitLab-style $`…`$; the backticks delimit it, so it may span lines
          let m = /^\$`([^`]+?)`\$/.exec(src);
          if (m) return { type: 'mathInline', raw: m[0], text: m[1].replace(/\s*\n\s*/g, ' '), display: false };
          m = /^\$\$(?!\s)([^$]+?)\$\$/.exec(src);
          if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: true };
          m = /^\$(?![\s$])((?:\\.|[^\\\n$])+?)\$(?!\d)/.exec(src);
          if (m && !/\s$/.test(m[1])) return { type: 'mathInline', raw: m[0], text: m[1], display: false };
        },
        renderer(t) { return renderMath(t.text, t.display); },
      },
      {
        name: 'mark', level: 'inline',
        start(src) { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^==(?=\S)([\s\S]*?\S)==(?!=)/.exec(src);
          if (m) return { type: 'mark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
      },
      {
        name: 'fnref', level: 'inline',
        start(src) { const i = src.indexOf('[^'); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^\[\^([^\]\n]+)\]/.exec(src);
          if (!m || !ctx || !ctx.fnDefs.has(m[1])) return;
          let n = ctx.fnOrder.indexOf(m[1]);
          if (n < 0) { ctx.fnOrder.push(m[1]); n = ctx.fnOrder.length - 1; }
          const refN = ctx.fnRefCount[m[1]] = (ctx.fnRefCount[m[1]] || 0) + 1;
          return { type: 'fnref', raw: m[0], label: m[1], n: n + 1, refN };
        },
        renderer(t) {
          const id = fnId(t.label);
          return `<sup><a class="fn-ref" href="#fn-${id}" id="fnref-${id}${t.refN > 1 ? '-' + t.refN : ''}">${t.n}</a></sup>`;
        },
      },
      {
        name: 'toc', level: 'block',
        start(src) { const m = /^\[toc\]/im.exec(src); return m ? m.index : undefined; },
        tokenizer(src) { const m = /^\[toc\][ \t]*(?:\n+|$)/i.exec(src); if (m) return { type: 'toc', raw: m[0] }; },
        renderer() { return '<nav class="toc-block"></nav>\n'; },
      },
    ],
  });

  const FM_RE = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;

  function markdownToHtml(src) {
    ctx = { slugs: new Map(), fnDefs: new Map(), fnOrder: [], fnRefCount: {} };
    marked.setOptions({ breaks: !!settings.breaks });
    let body = src, line = 0, fmHtml = '';
    const fm = FM_RE.exec(src);
    if (fm) {
      line = countNL(fm[0]);
      body = src.slice(fm[0].length);
      fmHtml = renderFrontMatter(fm[1]);
    }
    body = extractFootnotes(body);
    const tokens = marked.lexer(body);
    // Insert zero-height line anchors before each top-level block, used for scroll sync.
    const out = [];
    for (const t of tokens) {
      if (t.type !== 'space' && t.type !== 'def') {
        out.push({ type: 'html', block: true, pre: false, raw: '', text: `<div class="ln" data-line="${line}"></div>` });
      }
      out.push(t);
      line += countNL(t.raw || '');
    }
    out.links = tokens.links;
    const html = fmHtml + marked.parser(out) + renderFootnotes();
    ctx = null;
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style'], SANITIZE_DOM: false });
  }

  // ---------- Mermaid (lazy-loaded) ----------
  let mermaidLoad = null, mermaidTheme = null, mermaidSeq = 0;
  const mermaidCache = new Map();
  function loadMermaid() {
    return mermaidLoad ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid.min.js';
      s.onload = () => res(window.mermaid);
      s.onerror = () => { mermaidLoad = null; rej(new Error('Could not load Mermaid')); };
      document.head.append(s);
    });
  }
  async function renderMermaid() {
    const theme = isDark() ? 'dark' : 'default';
    const blocks = $$('.mermaid-block', el.preview);
    const todo = [];
    for (const b of blocks) {
      const src = decodeURIComponent(b.dataset.src);
      const hit = mermaidCache.get(theme + '\n' + src);
      if (hit) { b.innerHTML = hit; b.classList.remove('pending'); } else todo.push([b, src]);
    }
    if (!todo.length) return;
    let m;
    try { m = await loadMermaid(); } catch (e) { todo.forEach(([b]) => { b.innerHTML = `<div class="mermaid-error">${esc(e.message)}</div>`; }); return; }
    if (mermaidTheme !== theme) {
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' });
      mermaidTheme = theme;
    }
    for (const [b, src] of todo) {
      const id = 'mmd-' + (++mermaidSeq);
      let html;
      try {
        html = (await m.render(id, src)).svg;
        mermaidCache.set(theme + '\n' + src, html);
        if (mermaidCache.size > 60) mermaidCache.delete(mermaidCache.keys().next().value);
      } catch (e) {
        html = `<div class="mermaid-error">Mermaid: ${esc((e && e.message) || e)}</div>`;
        document.getElementById('d' + id)?.remove();
        document.getElementById(id)?.remove();
      }
      if (b.isConnected) { b.innerHTML = html; b.classList.remove('pending'); }
    }
    anchorCache = null;
  }

  // ---------- Render to preview ----------
  let lastRendered = null;
  function render(force = false) {
    const src = cm.getValue();
    if (!force && src === lastRendered) return;
    lastRendered = src;
    let html;
    try { html = markdownToHtml(src); } catch (e) { html = `<pre class="mermaid-error">Render error: ${esc(e.message)}</pre>`; console.error(e); }
    el.preview.innerHTML = html.trim() ? html : '<p class="preview-empty">Nothing to preview yet.</p>';
    postProcess();
    anchorCache = null;
    buildOutline();
    if (settings.mermaid) renderMermaid();
    if (settings.syncScroll && settings.mode === 'split' && activePane === 'editor') syncFromEditor();
  }
  const renderSoon = debounce(() => render(), () => Math.min(500, 80 + cm.getValue().length / 4000));

  function postProcess() {
    // Table of contents placeholders
    const tocs = $$('.toc-block', el.preview);
    if (tocs.length) {
      const hs = $$(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6', el.preview);
      const min = Math.min(...hs.map(h => +h.tagName[1]));
      for (const box of tocs) {
        const ul = document.createElement('ul');
        for (const h of hs) {
          const li = document.createElement('li');
          li.style.marginLeft = (+h.tagName[1] - min) * 1.2 + 'em';
          const a = document.createElement('a');
          a.href = '#' + h.id;
          a.textContent = headingText(h);
          li.append(a);
          ul.append(li);
        }
        box.append(ul);
      }
    }
    // Task checkboxes → index for source mapping
    $$('input.task', el.preview).forEach((cb, i) => { cb.dataset.task = i; });
  }
  const headingText = h => [...h.childNodes].filter(n => !(n.classList && n.classList.contains('anchor'))).map(n => n.textContent).join('').trim();

  // =====================================================================
  // Editor
  // =====================================================================
  const MODE = { name: 'gfm', highlightFormatting: true, fencedCodeBlockHighlighting: true, gitHubSpice: false, emoji: false };
  const cm = CodeMirror($('#editor'), {
    mode: MODE,
    lineNumbers: settings.lineNumbers,
    lineWrapping: settings.lineWrapping,
    styleActiveLine: true,
    autoCloseBrackets: settings.autoPairs ? '()[]{}``' : false,
    inputStyle: 'contenteditable',
    spellcheck: settings.spellcheck,
    tabSize: settings.tabSize,
    indentUnit: settings.tabSize,
    indentWithTabs: false,
    placeholder: 'Start writing Markdown…',
    cursorScrollMargin: 48,
    viewportMargin: 30,
    extraKeys: {
      Enter: 'newlineAndIndentContinueMarkdownList',
      Tab: c => {
        if (mathTabJump()) return;
        if (c.somethingSelected()) return c.execCommand('indentMore');
        if (/^\s*([-*+]|\d+[.)])\s/.test(c.getLine(c.getCursor().line))) return c.execCommand('indentMore');
        c.replaceSelection(' '.repeat(c.getOption('indentUnit')));
      },
      'Shift-Tab': 'indentLess',
    },
  });

  // ---------- Formatting helpers ----------
  const pos = (line, ch) => CodeMirror.Pos(line, ch);

  function wordRange(p) {
    const line = cm.getLine(p.line);
    let s = p.ch, e = p.ch;
    while (s > 0 && /[\p{L}\p{N}_'-]/u.test(line[s - 1])) s--;
    while (e < line.length && /[\p{L}\p{N}_'-]/u.test(line[e])) e++;
    return s === e ? null : { from: pos(p.line, s), to: pos(p.line, e) };
  }

  function toggleWrap(a, b = a, placeholder = 'text') {
    cm.operation(() => {
      let from = cm.getCursor('from'), to = cm.getCursor('to');
      if (!cm.somethingSelected()) {
        const line = cm.getLine(from.line);
        if (line.slice(from.ch - a.length, from.ch) === a && line.slice(from.ch, from.ch + b.length) === b) {
          cm.replaceRange('', pos(from.line, from.ch - a.length), pos(from.line, from.ch + b.length));
          return;
        }
        const w = wordRange(from);
        if (!w) {
          cm.replaceSelection(a + placeholder + b);
          cm.setSelection(pos(from.line, from.ch + a.length), pos(from.line, from.ch + a.length + placeholder.length));
          return;
        }
        ({ from, to } = w);
      }
      const sel = cm.getRange(from, to);
      // Selection already includes the markers
      if (sel.length >= a.length + b.length && sel.startsWith(a) && sel.endsWith(b)) {
        const inner = sel.slice(a.length, sel.length - b.length);
        cm.replaceRange(inner, from, to);
        cm.setSelection(from, cm.posFromIndex(cm.indexFromPos(from) + inner.length));
        return;
      }
      // Markers just outside the selection
      const before = cm.getRange(pos(from.line, Math.max(0, from.ch - a.length)), from);
      const after = cm.getRange(to, pos(to.line, to.ch + b.length));
      if (before === a && after === b) {
        cm.replaceRange('', to, pos(to.line, to.ch + b.length));
        cm.replaceRange('', pos(from.line, from.ch - a.length), from);
        const start = pos(from.line, from.ch - a.length);
        cm.setSelection(start, cm.posFromIndex(cm.indexFromPos(start) + sel.length));
        return;
      }
      cm.replaceRange(a + sel + b, from, to);
      const start = cm.posFromIndex(cm.indexFromPos(from) + a.length);
      cm.setSelection(start, cm.posFromIndex(cm.indexFromPos(start) + sel.length));
    });
  }

  function selectedLineRange() {
    const from = cm.getCursor('from'), to = cm.getCursor('to');
    let end = to.line;
    if (end > from.line && to.ch === 0) end--;
    return [from.line, end];
  }

  const LIST_RE = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;
  function toggleLinePrefix(kind) {
    const [a, b] = selectedLineRange();
    const tests = {
      ul: l => /^\s*[-*+]\s+(?!\[[ xX]\])/.test(l),
      ol: l => /^\s*\d+[.)]\s+/.test(l),
      task: l => /^\s*[-*+]\s+\[[ xX]\]\s/.test(l),
      quote: l => /^\s*>/.test(l),
    };
    const lines = [];
    for (let i = a; i <= b; i++) lines.push(cm.getLine(i));
    const nonEmpty = lines.filter(l => l.trim());
    const all = nonEmpty.length > 0 && nonEmpty.every(tests[kind]);
    let n = 1;
    const out = lines.map(l => {
      if (kind === 'quote') return all ? l.replace(/^(\s*)>\s?/, '$1') : (l.trim() ? '> ' + l : '>');
      if (!l.trim() && lines.length > 1) return l;
      const m = LIST_RE.exec(l);
      const indent = m ? m[1] : (/^\s*/.exec(l)[0]);
      const rest = m ? l.slice(m[0].length) : l.slice(indent.length);
      if (all) return indent + rest;
      const prefix = kind === 'ul' ? '- ' : kind === 'ol' ? `${n++}. ` : '- [ ] ';
      return indent + prefix + rest;
    });
    cm.operation(() => {
      cm.replaceRange(out.join('\n'), pos(a, 0), pos(b, cm.getLine(b).length));
      if (a === b) cm.setCursor(pos(a, out[0].length));
      else cm.setSelection(pos(a, 0), pos(b, out[out.length - 1].length));
    });
  }

  function setHeading(level) {
    const [a, b] = selectedLineRange();
    cm.operation(() => {
      for (let i = a; i <= b; i++) {
        const l = cm.getLine(i);
        const m = /^(#{1,6})\s+/.exec(l);
        const cur = m ? m[1].length : 0;
        const text = m ? l.slice(m[0].length) : l;
        const lvl = level === 'cycle' ? (cur + 1) % 7 : (cur === level ? 0 : level);
        cm.replaceRange((lvl ? '#'.repeat(lvl) + ' ' : '') + text, pos(i, 0), pos(i, l.length));
      }
      if (a === b) cm.setCursor(pos(a, cm.getLine(a).length));
    });
  }

  function insertBlock(text, cursorOffset = null) {
    const c = cm.getCursor('from');
    const line = cm.getLine(c.line);
    let prefix = '', at = c;
    if (line.trim()) { at = pos(c.line, line.length); prefix = '\n\n'; }
    else if (c.line > 0 && cm.getLine(c.line - 1).trim()) prefix = '\n';
    const suffix = (at.line < cm.lastLine() && cm.getLine(at.line + 1).trim()) ? '\n' : '';
    cm.replaceRange(prefix + text + suffix, at, cm.somethingSelected() && !line.trim() ? cm.getCursor('to') : at);
    const start = cm.indexFromPos(at) + prefix.length;
    cm.setCursor(cm.posFromIndex(start + (cursorOffset == null ? text.length : cursorOffset)));
  }

  function insertLink(image = false) {
    const sel = cm.getSelection();
    const isUrl = /^(https?:\/\/|www\.|mailto:|\.{0,2}\/)\S*$/.test(sel.trim());
    const from = cm.getCursor('from');
    const bang = image ? '!' : '';
    if (isUrl) {
      cm.replaceSelection(`${bang}[](${sel.trim()})`);
      cm.setCursor(pos(from.line, from.ch + bang.length + 1));
    } else {
      const text = sel || (image ? 'alt text' : 'link text');
      cm.replaceSelection(`${bang}[${text}](url)`);
      const s = from.ch + bang.length + text.length + 3;
      if (sel) cm.setSelection(pos(from.line, s), pos(from.line, s + 3));
      else cm.setSelection(pos(from.line, from.ch + bang.length + 1), pos(from.line, from.ch + bang.length + 1 + text.length));
    }
  }

  function codeBlock() {
    if (cm.somethingSelected()) {
      const [a, b] = selectedLineRange();
      const body = cm.getRange(pos(a, 0), pos(b, cm.getLine(b).length));
      cm.replaceRange('```\n' + body + '\n```', pos(a, 0), pos(b, cm.getLine(b).length));
      cm.setCursor(pos(a, 3));
    } else {
      insertBlock('```\n\n```', 3);
    }
  }

  function toggleTask() {
    const [a, b] = selectedLineRange();
    cm.operation(() => {
      for (let i = a; i <= b; i++) {
        const l = cm.getLine(i);
        let n;
        if (/^\s*[-*+]\s+\[ \]/.test(l)) n = l.replace(/\[ \]/, '[x]');
        else if (/^\s*[-*+]\s+\[[xX]\]/.test(l)) n = l.replace(/\[[xX]\]/, '[ ]');
        else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) n = l.replace(/^(\s*)([-*+]|\d+[.)])\s+/, '$1$2 [ ] ');
        else if (l.trim()) n = l.replace(/^(\s*)/, '$1- [ ] ');
        else n = '- [ ] ';
        cm.replaceRange(n, pos(i, 0), pos(i, l.length));
      }
    });
  }

  function moveLines(dir) {
    const [a, b] = selectedLineRange();
    if ((dir < 0 && a === 0) || (dir > 0 && b === cm.lastLine())) return;
    const anchor = cm.getCursor('anchor'), head = cm.getCursor('head');
    cm.operation(() => {
      const s = dir < 0 ? a - 1 : a, e = dir < 0 ? b : b + 1;
      const lines = [];
      for (let i = s; i <= e; i++) lines.push(cm.getLine(i));
      if (dir < 0) lines.push(lines.shift()); else lines.unshift(lines.pop());
      cm.replaceRange(lines.join('\n'), pos(s, 0), pos(e, cm.getLine(e).length));
      cm.setSelection(pos(anchor.line + dir, anchor.ch), pos(head.line + dir, head.ch));
    });
  }

  function duplicateLines() {
    const [a, b] = selectedLineRange();
    const text = cm.getRange(pos(a, 0), pos(b, cm.getLine(b).length));
    const c = cm.getCursor();
    cm.replaceRange('\n' + text, pos(b, cm.getLine(b).length));
    cm.setCursor(pos(c.line + (b - a + 1), c.ch));
  }

  // ---------- Table formatter ----------
  const splitRow = l => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '', code = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
      if (ch === '`') code = !code;
      if (ch === '|' && !code) { cells.push(cur.trim()); cur = ''; } else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };
  const strWidth = s => [...s].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

  function formatTable() {
    const c = cm.getCursor().line;
    if (!cm.getLine(c).includes('|')) { toast('Place the cursor inside a table'); return; }
    let a = c, b = c;
    while (a > 0 && cm.getLine(a - 1).includes('|') && cm.getLine(a - 1).trim()) a--;
    while (b < cm.lastLine() && cm.getLine(b + 1).includes('|') && cm.getLine(b + 1).trim()) b++;
    const rows = [];
    for (let i = a; i <= b; i++) rows.push(splitRow(cm.getLine(i)));
    const sepIdx = rows.findIndex(r => r.every(x => /^:?-+:?$/.test(x)));
    if (sepIdx !== 1) { toast('Not a Markdown table (missing --- separator row)'); return; }
    const cols = Math.max(...rows.map(r => r.length));
    rows.forEach(r => { while (r.length < cols) r.push(''); });
    const align = rows[1].map(x => x.startsWith(':') && x.endsWith(':') ? 'c' : x.endsWith(':') ? 'r' : x.startsWith(':') ? 'l' : '');
    const widths = Array.from({ length: cols }, (_, i) => Math.max(3, ...rows.filter((_, ri) => ri !== 1).map(r => strWidth(r[i]))));
    const pad = (s, w, al) => {
      const d = w - strWidth(s);
      if (al === 'r') return ' '.repeat(d) + s;
      if (al === 'c') return ' '.repeat(Math.floor(d / 2)) + s + ' '.repeat(Math.ceil(d / 2));
      return s + ' '.repeat(d);
    };
    const out = rows.map((r, ri) => {
      if (ri === 1) return '|' + widths.map((w, i) => {
        const al = align[i];
        const dash = '-'.repeat(w - (al === 'c' ? 2 : al ? 1 : 0));
        return ' ' + (al === 'c' || al === 'l' ? ':' : '') + dash + (al === 'c' || al === 'r' ? ':' : '') + ' ';
      }).join('|') + '|';
      return '|' + r.map((x, i) => ' ' + pad(x, widths[i], align[i]) + ' ').join('|') + '|';
    });
    const cur = cm.getCursor();
    cm.replaceRange(out.join('\n'), pos(a, 0), pos(b, cm.getLine(b).length));
    cm.setCursor(pos(cur.line, Math.min(cur.ch, cm.getLine(cur.line).length)));
  }

  // ---------- Math (LaTeX) toolbar ----------
  // Shown while the cursor is inside $…$, $$…$$ or a ```math/latex/katex fence. Templates use •
  // as a slot: the first slot receives the selection, the cursor lands on the next empty one.
  const MATH_LANGS = new Set(['math', 'latex', 'katex', 'tex']);
  const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
  const INLINE_MATH_RE = /\$\$(?!\s)[^$]+?\$\$|\$(?![\s$])(?:\\.|[^\\\n$])+?\$(?!\d)/g;
  const closesFence = (l, f) => { const m = /^\s*(`{3,}|~{3,})\s*$/.exec(l); return !!m && m[1][0] === f.ch && m[1].length >= f.len; };
  const opensDollarBlock = l => { const t = l.trimStart(); return t.startsWith('$$') && !t.slice(2).includes('$$'); };

  function mathContext() {
    if (!settings.math) return null;
    const c = cm.getCursor();
    let fence = null, dollar = false;
    for (let i = 0; i < c.line; i++) {
      const l = cm.getLine(i);
      if (fence) { if (closesFence(l, fence)) fence = null; continue; }
      if (dollar) { if (l.includes('$$')) dollar = false; continue; }
      const f = FENCE_RE.exec(l);
      if (f) { fence = { ch: f[1][0], len: f[1].length, math: MATH_LANGS.has(f[2].toLowerCase()) }; continue; }
      if (opensDollarBlock(l)) dollar = true;
    }
    const line = cm.getLine(c.line);
    if (fence) return fence.math && !closesFence(line, fence) ? 'fence' : null;
    if (dollar) { const k = line.indexOf('$$'); return k < 0 || c.ch <= k ? 'block' : null; }
    if (FENCE_RE.test(line)) return null;
    if (opensDollarBlock(line)) return c.ch >= line.indexOf('$$') + 2 ? 'block' : null;
    for (const m of line.matchAll(INLINE_MATH_RE)) {
      if (m.index > 0 && line[m.index - 1] === '\\') continue;
      if (((line.slice(0, m.index).match(/`/g) || []).length) % 2) continue; // inside inline code
      const d = m[0].startsWith('$$') ? 2 : 1;
      if (c.ch >= m.index + d && c.ch <= m.index + m[0].length - d) return 'inline';
    }
    return null;
  }

  // [label (LaTeX, or plain text when prefixed with "!"), template (defaults to label), tooltip]
  const sym = list => list.split(' ').map(s => [s]);
  const MATH_TABS = [
    ['struct', 'Structures', [
      ['\\frac{a}{b}', '\\frac{•}{•}', 'Fraction'], ['x^{n}', '^{•}', 'Superscript'], ['x_{i}', '_{•}', 'Subscript'],
      ['\\sqrt{x}', '\\sqrt{•}', 'Square root'], ['\\sqrt[n]{x}', '\\sqrt[•]{•}', 'n-th root'],
      ['\\sum', '\\sum_{•}^{•}', 'Sum'], ['\\prod', '\\prod_{•}^{•}', 'Product'], ['\\int', '\\int_{•}^{•}', 'Integral'],
      ['\\iint', '\\iint_{•}', 'Double integral'], ['\\oint', '\\oint_{•}', 'Contour integral'],
      ['\\lim', '\\lim_{• \\to •}', 'Limit'], ['\\tfrac{d}{dx}', '\\frac{d•}{d•}', 'Derivative'],
      ['\\tfrac{\\partial}{\\partial x}', '\\frac{\\partial •}{\\partial •}', 'Partial derivative'],
      ['\\binom{n}{k}', '\\binom{•}{•}', 'Binomial'], ['\\text{T}', '\\text{•}', 'Text'],
      ['!cases', '\\begin{cases} • & \\text{if } \\\\ & \\text{otherwise} \\end{cases}', 'Piecewise (cases)'],
      ['!align', '\\begin{aligned} • &= \\\\ &= \\end{aligned}', 'Aligned equations'],
      ['\\sin', '\\sin '], ['\\cos', '\\cos '], ['\\tan', '\\tan '], ['\\log', '\\log '], ['\\ln', '\\ln '],
      ['\\exp', '\\exp '], ['\\max', '\\max_{•}'], ['\\min', '\\min_{•}'], ['\\det', '\\det '],
    ]],
    ['greek', 'Greek', sym('\\alpha \\beta \\gamma \\delta \\epsilon \\varepsilon \\zeta \\eta \\theta \\vartheta \\iota \\kappa \\lambda \\mu \\nu \\xi \\pi \\rho \\sigma \\tau \\upsilon \\phi \\varphi \\chi \\psi \\omega \\Gamma \\Delta \\Theta \\Lambda \\Xi \\Pi \\Sigma \\Upsilon \\Phi \\Psi \\Omega')],
    ['ops', 'Operators', sym('\\pm \\mp \\times \\div \\cdot \\ast \\circ \\bullet \\cup \\cap \\setminus \\oplus \\otimes \\wedge \\vee \\neg \\nabla \\partial \\infty \\forall \\exists \\nexists \\emptyset \\ldots \\cdots \\vdots \\ddots \\prime \\hbar \\ell \\Re \\Im \\aleph')],
    ['rel', 'Relations', sym('= \\neq \\approx \\equiv \\sim \\simeq \\cong \\propto < > \\leq \\geq \\ll \\gg \\in \\notin \\ni \\subset \\supset \\subseteq \\supseteq \\mid \\parallel \\perp \\models \\vdash')],
    ['arrows', 'Arrows', [
      ...sym('\\to \\leftarrow \\leftrightarrow \\Rightarrow \\Leftarrow \\Leftrightarrow \\implies \\iff \\mapsto \\uparrow \\downarrow \\longrightarrow \\hookrightarrow \\rightleftharpoons'),
      ['\\xrightarrow{f}', '\\xrightarrow{•}', 'Labelled arrow'],
    ]],
    ['accents', 'Accents', [
      ['\\hat{x}', '\\hat{•}'], ['\\bar{x}', '\\bar{•}'], ['\\tilde{x}', '\\tilde{•}'], ['\\vec{x}', '\\vec{•}'],
      ['\\dot{x}', '\\dot{•}'], ['\\ddot{x}', '\\ddot{•}'], ['\\overline{xy}', '\\overline{•}'], ['\\underline{xy}', '\\underline{•}'],
      ['\\widehat{xy}', '\\widehat{•}'], ['\\overbrace{xy}', '\\overbrace{•}^{•}'], ['\\underbrace{xy}', '\\underbrace{•}_{•}'],
      ['\\mathbb{R}', '\\mathbb{•}', 'Blackboard bold'], ['\\mathcal{L}', '\\mathcal{•}', 'Calligraphic'],
      ['\\mathfrak{g}', '\\mathfrak{•}', 'Fraktur'], ['\\mathbf{x}', '\\mathbf{•}', 'Bold'], ['\\boldsymbol{\\alpha}', '\\boldsymbol{•}', 'Bold symbol'],
      ['\\mathrm{d}', '\\mathrm{•}', 'Upright'], ['\\mathsf{A}', '\\mathsf{•}', 'Sans-serif'], ['\\mathit{x}', '\\mathit{•}', 'Italic'],
      ['\\color{red}{x}', '\\color{red}{•}', 'Color'],
    ]],
    ['brackets', 'Brackets', [
      ['\\left( x \\right)', '\\left( • \\right)'], ['\\left[ x \\right]', '\\left[ • \\right]'], ['\\left\\{ x \\right\\}', '\\left\\{ • \\right\\}'],
      ['\\left| x \\right|', '\\left| • \\right|', 'Absolute value'], ['\\left\\| x \\right\\|', '\\left\\| • \\right\\|', 'Norm'],
      ['\\langle x \\rangle', '\\langle • \\rangle'], ['\\lfloor x \\rfloor', '\\lfloor • \\rfloor', 'Floor'], ['\\lceil x \\rceil', '\\lceil • \\rceil', 'Ceiling'],
      ['\\left(\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}\\right)', '\\begin{pmatrix} • & \\\\ & \\end{pmatrix}', 'Matrix (parentheses)'],
      ['\\left[\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}\\right]', '\\begin{bmatrix} • & \\\\ & \\end{bmatrix}', 'Matrix (brackets)'],
      ['\\left|\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}\\right|', '\\begin{vmatrix} • & \\\\ & \\end{vmatrix}', 'Determinant'],
    ]],
  ];
  const MATH_CTX_LABEL = { inline: 'Inline math', block: 'Display math', fence: 'LaTeX block' };

  function insertMath(tpl) {
    const sel = cm.getSelection();
    const parts = tpl.split('•');
    if (parts.length === 1) {
      const next = cm.getRange(cm.getCursor('to'), pos(cm.getCursor('to').line, cm.getCursor('to').ch + 1));
      cm.replaceSelection(/\\[a-zA-Z]+$/.test(tpl) && (!next || /[a-zA-Z]/.test(next)) ? tpl + ' ' : tpl);
      return;
    }
    const start = cm.indexFromPos(cm.getCursor('from'));
    const text = parts[0] + sel + parts.slice(1).join('');
    cm.replaceSelection(text);
    // Cursor goes to the first slot, or the second one if the selection filled the first
    const slot = sel && parts.length > 2 ? parts[0].length + sel.length + parts[1].length : parts[0].length;
    cm.setCursor(cm.posFromIndex(start + (sel && parts.length === 2 ? text.length : slot)));
  }

  // Tab inside math jumps to the next empty {} on the line
  function mathTabJump() {
    if (cm.somethingSelected() || !mathContext()) return false;
    const c = cm.getCursor();
    const i = cm.getLine(c.line).indexOf('{}', c.ch);
    if (i < 0) return false;
    cm.setCursor(pos(c.line, i + 1));
    return true;
  }

  const mathbar = { el: $('#mathbar'), ctx: $('#mb-ctx'), tabs: $('#mb-tabs'), palette: $('#mb-palette'), shown: null, dismissed: false, built: null };
  const katexLabel = tex => {
    if (tex.startsWith('!')) return `<span class="mb-text">${esc(tex.slice(1))}</span>`;
    try { return katex.renderToString(tex, { throwOnError: false, output: 'html' }); } catch { return esc(tex); }
  };

  function buildMathTabs() {
    mathbar.tabs.innerHTML = MATH_TABS.map(([id, name]) => `<button role="tab" data-tab="${id}">${esc(name)}</button>`).join('');
  }

  function buildMathPalette() {
    const tab = MATH_TABS.find(t => t[0] === settings.mathTab) || MATH_TABS[0];
    $$('[data-tab]', mathbar.tabs).forEach(b => { const on = b.dataset.tab === tab[0]; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    if (mathbar.built === tab[0]) return;
    mathbar.built = tab[0];
    mathbar.palette.innerHTML = tab[2].map(([label, tpl = label, title], i) =>
      `<button class="mb-btn" data-i="${i}" title="${esc((title ? title + ': ' : '') + tpl.replace(/•/g, '…'))}">${window.katex ? katexLabel(label) : esc(label.replace(/^!/, ''))}</button>`).join('');
  }

  function updateMathBar() {
    const ctx = settings.mathToolbar && settings.mode !== 'preview' ? mathContext() : null;
    if (!ctx) mathbar.dismissed = false;
    const show = ctx && !mathbar.dismissed ? ctx : null;
    if (show === mathbar.shown) return;
    const toggled = !show !== !mathbar.shown;
    mathbar.shown = show;
    mathbar.el.hidden = !show;
    if (!show) { if (toggled) cm.refresh(); return; }
    mathbar.ctx.textContent = MATH_CTX_LABEL[show];
    if (!mathbar.tabs.firstChild) buildMathTabs();
    buildMathPalette();
    if (toggled) { cm.refresh(); cm.scrollIntoView(null, 48); }
  }
  const updateMathBarSoon = debounce(updateMathBar, 60);

  // Keep focus and selection in the editor while using the toolbar
  mathbar.el.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  mathbar.el.addEventListener('click', e => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { settings.mathTab = tabBtn.dataset.tab; saveSettings(); buildMathPalette(); return; }
    if (e.target.closest('#mb-close')) { mathbar.dismissed = true; updateMathBar(); cm.focus(); return; }
    const b = e.target.closest('.mb-btn');
    if (!b) return;
    const tab = MATH_TABS.find(t => t[0] === mathbar.built);
    const [label, tpl = label] = tab[2][+b.dataset.i];
    insertMath(tpl);
    cm.focus();
  });

  // ---------- Commands ----------
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  const commands = {
    bold: () => toggleWrap('**', '**', 'bold text'),
    italic: () => toggleWrap('*', '*', 'italic text'),
    strike: () => toggleWrap('~~', '~~', 'text'),
    code: () => toggleWrap('`', '`', 'code'),
    mathInline: () => toggleWrap('$', '$', 'x^2'),
    heading: n => setHeading(n === 'cycle' ? 'cycle' : +n),
    ul: () => toggleLinePrefix('ul'),
    ol: () => toggleLinePrefix('ol'),
    task: () => toggleLinePrefix('task'),
    quote: () => toggleLinePrefix('quote'),
    toggleTask,
    link: () => insertLink(false),
    image: () => insertLink(true),
    codeBlock,
    table: () => insertBlock('| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n| Cell     | Cell     | Cell     |\n| Cell     | Cell     | Cell     |', 2),
    hr: () => insertBlock('---\n'),
    mathBlock: () => insertBlock('$$\n\n$$', 3),
    mermaid: () => insertBlock('```mermaid\ngraph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n```'),
    details: () => insertBlock('<details>\n<summary>Summary</summary>\n\nHidden content goes here.\n\n</details>', 28),
    toc: () => insertBlock('[TOC]\n'),
    date: () => cm.replaceSelection(today()),
    frontmatter: () => {
      if (FM_RE.test(cm.getValue())) { toast('This document already has front matter'); cm.setCursor(pos(1, 0)); return; }
      const t = `---\ntitle: ${current?.title || 'Untitled'}\ndate: ${today()}\ntags: []\n---\n\n`;
      cm.replaceRange(t, pos(0, 0));
      cm.setCursor(pos(1, 7));
    },
    footnote: () => {
      const text = cm.getValue();
      let n = 1;
      for (const m of text.matchAll(/\[\^(\d+)\]/g)) n = Math.max(n, +m[1] + 1);
      const c = cm.getCursor('to');
      cm.replaceRange(`[^${n}]`, c);
      const last = cm.lastLine();
      const tail = cm.getLine(last).trim() ? '\n\n' : (last > 0 && cm.getLine(last - 1).trim() ? '\n' : '');
      cm.replaceRange(`${tail}[^${n}]: `, pos(last, cm.getLine(last).length));
      cm.setCursor(pos(cm.lastLine(), cm.getLine(cm.lastLine()).length));
    },
    formatTable,
    moveUp: () => moveLines(-1),
    moveDown: () => moveLines(1),
    duplicate: duplicateLines,

    newDoc: () => newDocument(),
    openFile: () => openFile(),
    save: () => saveToFile(false),
    saveAs: () => saveToFile(true),
    exportHtml: () => exportHtml(),
    copyHtml: () => copyHtml(),
    downloadMd: () => downloadMd(),
    duplicateDoc: () => duplicateDocument(),
    deleteDoc: () => deleteDocument(current.id),

    setMode: m => setMode(m),
    cycleMode: () => setMode({ edit: 'split', split: 'preview', preview: 'edit' }[settings.mode]),
    toggleSidebar: () => { settings.sidebar = !settings.sidebar; saveSettings(); applyLayout(); },
    toggleSync: () => { settings.syncScroll = !settings.syncScroll; saveSettings(); applyLayout(); toast(`Scroll sync ${settings.syncScroll ? 'on' : 'off'}`); if (settings.syncScroll) syncFromEditor(); },
    cycleTheme: () => {
      const order = ['auto', 'light', 'dark', 'sepia'];
      settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
      saveSettings(); applyTheme();
      toast(`Theme: ${{ auto: 'System', light: 'Light', dark: 'Dark', sepia: 'Sepia' }[settings.theme]}`);
    },
    focusMode: () => { el.body.classList.toggle('focus'); cm.refresh(); if (el.body.classList.contains('focus')) toast('Focus mode — press Esc to exit'); },
    find: () => openFind(false),
    replace: () => openFind(true),
    settings: () => openSettings(),
    help: () => { if (!el.helpDlg.open) el.helpDlg.showModal(); },
  };
  const EDITOR_CMDS = new Set(['bold', 'italic', 'strike', 'code', 'mathInline', 'heading', 'ul', 'ol', 'task', 'quote', 'toggleTask', 'link', 'image', 'codeBlock', 'table', 'hr', 'mathBlock', 'mermaid', 'details', 'toc', 'date', 'frontmatter', 'footnote', 'formatTable', 'moveUp', 'moveDown', 'duplicate']);

  function run(name, arg) {
    const fn = commands[name];
    if (!fn) return;
    if (EDITOR_CMDS.has(name)) {
      if (settings.mode === 'preview') setMode('split');
      fn(arg);
      cm.focus();
    } else {
      fn(arg);
    }
  }

  // =====================================================================
  // Documents
  // =====================================================================
  let docs = [];
  let current = null;
  const cmDocs = new Map();
  let suppressDirty = false;

  function makeDoc(fields = {}) {
    const now = Date.now();
    return { id: uid(), title: 'Untitled', titleLocked: false, content: '', created: now, updated: now, handle: null, fileName: null, fileDirty: false, fileMtime: 0, ...fields };
  }

  function autoTitle(text) {
    const fm = FM_RE.exec(text);
    if (fm) { const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]); if (t) return t[1].slice(0, 80); }
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text);
    if (h) return h[1].replace(/[*_`~[\]]/g, '').slice(0, 80);
    const first = text.split('\n').find(l => l.trim());
    return first ? first.replace(/^[#>*\-+\s\d.]+/, '').replace(/[*_`~[\]]/g, '').slice(0, 60) || 'Untitled' : 'Untitled';
  }

  const persist = debounce(() => flushSave(), 400);
  async function flushSave() {
    persist.cancel();
    if (!current) return;
    current.content = cm.getValue();
    if (!current.titleLocked) {
      const t = autoTitle(current.content);
      if (t !== current.title) { current.title = t; if (document.activeElement !== el.title) el.title.value = t; renderDocList(); }
    }
    try { await db.put(current); updateSaveStatus('saved'); } catch (e) { updateSaveStatus('error'); console.error(e); }
  }

  function updateSaveStatus(state) {
    const d = current;
    if (!d) return;
    el.dirtyDot.hidden = !d.fileDirty;
    document.title = appTitle();
    if (state === 'saving') el.stSave.textContent = 'Saving…';
    else if (state === 'error') el.stSave.textContent = '⚠ Could not save locally';
    else el.stSave.textContent = d.handle
      ? (d.fileDirty ? `● ${d.fileName}: unsaved (Ctrl+S)` : `✓ Saved to ${d.fileName}`)
      : '✓ Saved in browser';
  }

  function getCmDoc(d) {
    let doc = cmDocs.get(d.id);
    if (!doc) { doc = CodeMirror.Doc(d.content, MODE); cmDocs.set(d.id, doc); }
    return doc;
  }

  async function switchTo(id) {
    if (current && current.id !== id) await flushSave();
    const d = docs.find(x => x.id === id);
    if (!d) return;
    current = d;
    store.set('mde.current', id);
    cm.swapDoc(getCmDoc(d));
    el.title.value = d.title;
    lastRendered = null;
    render();
    el.previewPane.scrollTop = 0;
    renderDocList();
    updateStats();
    updateSaveStatus();
    if (findState.open) runFind();
    if (settings.mode !== 'preview') cm.focus();
  }

  async function addDoc(d) {
    docs.unshift(d);
    try { await db.put(d); if (d.handle) await db.putHandle(d.id, d.handle); } catch (e) { console.error(e); }
    await switchTo(d.id);
  }

  const newDocument = () => addDoc(makeDoc());

  function duplicateDocument() {
    flushSave();
    addDoc(makeDoc({ title: current.title + ' (copy)', titleLocked: true, content: cm.getValue() }));
    toast('Duplicated');
  }

  async function deleteDocument(id) {
    const d = docs.find(x => x.id === id);
    if (!d) return;
    const extra = d.handle ? `\n\nThe file "${d.fileName}" on disk will NOT be deleted.` : '';
    if (!confirm(`Delete "${d.title}" from the document list?${extra}`)) return;
    docs = docs.filter(x => x.id !== id);
    cmDocs.delete(id);
    try { await db.del(id); } catch (e) { console.error(e); }
    if (current && current.id === id) {
      current = null;
      if (docs.length) await switchTo(docs.sort((a, b) => b.updated - a.updated)[0].id);
      else await newDocument();
    } else renderDocList();
    toast('Document deleted');
  }

  const relTime = t => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(t).toLocaleDateString();
  };

  function renderDocList() {
    const q = el.docSearch.value.trim().toLowerCase();
    const list = docs
      .filter(d => !q || d.title.toLowerCase().includes(q) || (d.content || '').toLowerCase().includes(q))
      .sort((a, b) => b.updated - a.updated);
    el.docList.innerHTML = list.length ? '' : `<li class="empty">${q ? 'No matches' : 'No documents'}</li>`;
    for (const d of list) {
      const li = document.createElement('li');
      li.dataset.id = d.id;
      if (current && d.id === current.id) li.className = 'on';
      li.innerHTML = `<span class="t"></span><span class="m"></span><button class="x" title="Delete">✕</button>`;
      li.querySelector('.t').textContent = (d.fileDirty ? '● ' : '') + (d.title || 'Untitled');
      li.querySelector('.m').textContent = relTime(d.updated) + (d.fileName ? ' · ' + d.fileName : '');
      li.title = d.fileName ? `File: ${d.fileName}` : 'Stored in browser';
      el.docList.append(li);
    }
  }

  // ---------- Files ----------
  const MD_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'], 'text/plain': ['.txt'] } }];
  const safeName = t => (t || 'untitled').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 100) || 'untitled';

  async function verifyPermission(h, write) {
    const opts = { mode: write ? 'readwrite' : 'read' };
    if ((await h.queryPermission(opts)) === 'granted') return true;
    return (await h.requestPermission(opts)) === 'granted';
  }

  async function openFile() {
    if (!window.showOpenFilePicker) { el.fileInput.click(); return; }
    let handles;
    try { handles = await window.showOpenFilePicker({ multiple: true, types: MD_TYPES }); } catch (e) { if (e.name !== 'AbortError') toast(e.message); return; }
    for (const h of handles) await openHandle(h);
  }

  async function openHandle(h) {
    for (const d of docs) {
      if (d.handle && await d.handle.isSameEntry(h).catch(() => false)) {
        const f = await h.getFile();
        const text = await f.text();
        if (!d.fileDirty && text !== d.content) {
          d.content = text;
          d.fileMtime = f.lastModified;
          const doc = cmDocs.get(d.id);
          if (doc) { suppressDirty = true; doc.setValue(text); suppressDirty = false; }
          await db.put(d).catch(() => {});
        }
        d.handle = h;
        await switchTo(d.id);
        toast(`Switched to ${h.name}`);
        return;
      }
    }
    const f = await h.getFile();
    await addDoc(makeDoc({ title: stripExt(h.name), titleLocked: true, content: await f.text(), handle: h, fileName: h.name, fileMtime: f.lastModified }));
    toast(`Opened ${h.name}`);
  }

  async function openPlainFile(file) {
    await addDoc(makeDoc({ title: stripExt(file.name), titleLocked: true, content: await file.text() }));
    toast(`Imported ${file.name} (use Save as to write it back)`);
  }

  async function saveToFile(saveAs) {
    if (!current) return;
    let h = saveAs ? null : current.handle;
    if (!h) {
      if (!window.showSaveFilePicker) { downloadMd(); return; }
      try {
        h = await window.showSaveFilePicker({ suggestedName: safeName(current.title) + '.md', types: MD_TYPES });
      } catch (e) { if (e.name !== 'AbortError') toast(e.message); return; }
    }
    try {
      if (!(await verifyPermission(h, true))) { toast('Permission to write the file was denied'); return; }
      const text = cm.getValue();
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      if (current.handle !== h) {
        current.handle = h;
        await db.putHandle(current.id, h).catch(e => console.error(e));
      }
      current.fileName = h.name;
      current.fileDirty = false;
      current.fileMtime = (await h.getFile()).lastModified;
      if (saveAs || !current.titleLocked) { current.title = stripExt(h.name); current.titleLocked = true; el.title.value = current.title; }
      await flushSave();
      renderDocList();
      updateSaveStatus();
      toast(`Saved ${h.name}`);
    } catch (e) {
      toast('Save failed: ' + e.message, 4000);
      console.error(e);
    }
  }

  async function checkDiskChange() {
    const d = current;
    if (!d || !d.handle || d.fileDirty) return;
    try {
      if ((await d.handle.queryPermission({ mode: 'read' })) !== 'granted') return;
      const f = await d.handle.getFile();
      if (f.lastModified <= d.fileMtime) return;
      const text = await f.text();
      d.fileMtime = f.lastModified;
      if (text !== cm.getValue() && d === current) {
        const c = cm.getCursor();
        suppressDirty = true;
        cm.replaceRange(text, pos(0, 0), pos(cm.lastLine(), cm.getLine(cm.lastLine()).length));
        suppressDirty = false;
        cm.setCursor(c);
        toast(`Reloaded ${d.fileName} (changed on disk)`);
      }
      flushSave();
    } catch { /* file moved or permission revoked */ }
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const downloadMd = () => download(safeName(current.title) + '.md', cm.getValue(), 'text/markdown');

  const EXPORT_CSS = `
body{margin:0;background:#fff;color:#1f2328;font:16px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.markdown-body{max-width:860px;margin:0 auto;padding:40px 32px 80px;word-wrap:break-word}
h1,h2,h3,h4,h5,h6{margin:1.5em 0 .6em;font-weight:650;line-height:1.25}
h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid #d1d9e0}h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid #d1d9e0}
h3{font-size:1.25em}h4{font-size:1em}h5{font-size:.875em}h6{font-size:.85em;color:#59636e}
.markdown-body>:first-child{margin-top:0}
p,ul,ol,blockquote,pre,table,details,dl{margin:0 0 1em}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
ul,ol{padding-left:2em}li+li{margin-top:.25em}
li:has(>input[type=checkbox]){list-style:none}li>input[type=checkbox]{margin:0 .4em 0 -1.4em;vertical-align:middle}
blockquote{padding:0 1em;color:#59636e;border-left:.25em solid #d1d9e0}
hr{height:2px;border:0;background:#d1d9e0;margin:1.6em 0}img{max-width:100%}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
:not(pre)>code{font-size:.86em;padding:.15em .4em;background:#f6f8fa;border:1px solid #eaeef2;border-radius:5px}
pre{padding:14px 16px;overflow:auto;font-size:.85em;line-height:1.5;background:#f6f8fa;border:1px solid #eaeef2;border-radius:8px}
pre code.hljs{background:transparent;padding:0}
table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto}
th,td{padding:6px 13px;border:1px solid #d1d9e0}th{background:#f6f8fa}
details{border:1px solid #d1d9e0;border-radius:8px;padding:.5em 1em}summary{cursor:pointer;font-weight:600}
mark{background:#fff3a3}.math-block{overflow-x:auto;margin:0 0 1em}.mermaid-block{text-align:center;margin:0 0 1em}
.footnotes{font-size:.875em;color:#59636e;border-top:1px solid #d1d9e0;margin-top:2.5em;padding-top:1em}.footnotes p{display:inline}
.toc-block{border:1px solid #d1d9e0;border-radius:8px;padding:.75em 1.25em;background:#f6f8fa}.toc-block ul{margin:0;padding-left:0;list-style:none}
.frontmatter{font-size:.85em}.frontmatter table{display:table;width:100%}
@media print{.markdown-body{max-width:none;padding:0}pre,table,img{break-inside:avoid}}`;

  // Standalone, light-themed copy of the rendered document (for export and copy).
  function cleanClone(clone) {
    clone.querySelectorAll('.ln, .copy-code, .code-lang, .anchor, .preview-empty').forEach(n => n.remove());
    clone.querySelectorAll('input.task').forEach(n => { n.setAttribute('disabled', ''); n.removeAttribute('data-task'); });
    clone.querySelectorAll('.mermaid-block').forEach(n => { n.removeAttribute('data-src'); n.classList.remove('pending'); });
    return clone;
  }

  async function cleanPreviewHtml() {
    render(true);
    const clone = el.preview.cloneNode(true);
    // Diagrams rendered for a dark theme would be unreadable on white paper
    const blocks = $$('.mermaid-block[data-src]', clone);
    if (blocks.length && settings.mermaid && mermaidTheme !== 'default') {
      try {
        const m = await loadMermaid();
        m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', fontFamily: 'inherit' });
        mermaidTheme = 'default';
        for (const b of blocks) {
          const src = decodeURIComponent(b.dataset.src);
          const key = 'default\n' + src;
          let svg = mermaidCache.get(key);
          if (!svg) {
            const id = 'mmd-' + (++mermaidSeq);
            try { svg = (await m.render(id, src)).svg; mermaidCache.set(key, svg); } catch { document.getElementById('d' + id)?.remove(); continue; }
          }
          b.innerHTML = svg;
        }
      } catch { /* keep whatever was rendered */ }
    }
    return cleanClone(clone).innerHTML.replace(/\n{3,}/g, '\n\n').trim();
  }

  function standaloneHtml(body) {
    const head = [];
    if (body.includes('class="katex')) head.push(`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">`);
    if (body.includes('class="hljs')) head.push(`<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">`);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(current.title)}</title>
${head.join('\n')}
<style>${EXPORT_CSS}</style>
</head>
<body>
<article class="markdown-body">
${body}
</article>
</body>
</html>
`;
  }

  async function exportHtml() {
    download(safeName(current.title) + '.html', standaloneHtml(await cleanPreviewHtml()), 'text/html');
  }

  async function copyHtml() {
    try { await navigator.clipboard.writeText(await cleanPreviewHtml()); toast('HTML copied to clipboard'); } catch { toast('Clipboard not available'); }
  }

  const appTitle = () => (current && current.fileDirty ? '● ' : '') + ((current && current.title) || 'Untitled') + ' — Markdown Editor';

  // =====================================================================
  // Layout, theme, settings
  // =====================================================================
  const mql = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => {
    const t = el.root.dataset.theme;
    if (t) return t === 'dark';
    return mql.matches;
  };

  function applyTheme() {
    if (settings.theme === 'auto') delete el.root.dataset.theme;
    else el.root.dataset.theme = settings.theme;
    const dark = isDark();
    el.hljsDark.disabled = !dark;
    el.hljsLight.disabled = dark;
    el.themeBtn.title = `Theme: ${{ auto: 'System', light: 'Light', dark: 'Dark', sepia: 'Sepia' }[settings.theme]} (click to change)`;
    if (settings.mermaid && $('.mermaid-block', el.preview)) render(true);
  }
  mql.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });

  function setMode(m) {
    if (!['edit', 'split', 'preview'].includes(m)) return;
    settings.mode = m;
    saveSettings();
    applyLayout();
    if (m !== 'preview') { cm.refresh(); cm.focus(); }
    updateMathBar();
    if (m === 'split') requestAnimationFrame(syncFromEditor);
  }

  function applyLayout() {
    el.workspace.classList.remove('mode-edit', 'mode-split', 'mode-preview');
    el.workspace.classList.add('mode-' + settings.mode);
    $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === settings.mode));
    el.editorPane.style.flexBasis = settings.mode === 'split' ? settings.split + '%' : '';
    el.body.classList.toggle('no-sidebar', !settings.sidebar);
    el.syncBtn.classList.toggle('on', settings.syncScroll);
    el.syncBtn.title = `Sync scrolling: ${settings.syncScroll ? 'on' : 'off'}`;
    $$('.side-tabs button').forEach(b => b.classList.toggle('on', b.dataset.side === settings.sideTab));
    $('#side-docs').hidden = settings.sideTab !== 'docs';
    $('#side-outline').hidden = settings.sideTab !== 'outline';
    anchorCache = null;
    cm.refresh();
  }

  function applySettings(rerender = true) {
    cm.setOption('lineNumbers', settings.lineNumbers);
    cm.setOption('lineWrapping', settings.lineWrapping);
    cm.setOption('tabSize', +settings.tabSize);
    cm.setOption('indentUnit', +settings.tabSize);
    cm.setOption('spellcheck', settings.spellcheck);
    cm.setOption('autoCloseBrackets', settings.autoPairs ? '()[]{}``' : false);
    el.root.style.setProperty('--editor-font', FONTS[settings.editorFont] || FONTS.mono);
    el.root.style.setProperty('--editor-size', settings.fontSize + 'px');
    el.root.style.setProperty('--preview-size', settings.previewFontSize + 'px');
    el.preview.className = `markdown-body s-${settings.previewStyle} w-${settings.previewWidth}`;
    applyTheme();
    applyLayout();
    updateMathBar();
    if (rerender) render(true);
  }

  function fillSettingsForm() {
    for (const input of el.settingsDlg.querySelectorAll('[name]')) {
      const v = settings[input.name];
      if (input.type === 'checkbox') input.checked = !!v; else input.value = v;
    }
  }
  function openSettings() { fillSettingsForm(); el.settingsDlg.showModal(); }
  el.settingsDlg.addEventListener('input', e => {
    const t = e.target;
    if (!t.name) return;
    let v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value;
    if (t.type === 'number') {
      if (!t.value || Number.isNaN(v)) return;
      v = Math.min(+t.max || 99, Math.max(+t.min || 1, v));
    }
    settings[t.name] = v;
    saveSettings();
    applySettings();
  });
  $('#settings-reset', el.settingsDlg).addEventListener('click', e => {
    e.preventDefault();
    const keep = { mode: settings.mode, split: settings.split, sidebar: settings.sidebar, sideTab: settings.sideTab };
    settings = { ...DEFAULTS, ...keep };
    saveSettings();
    fillSettingsForm();
    applySettings();
  });

  // ---------- Resizer ----------
  el.resizer.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.resizer.setPointerCapture(e.pointerId);
    el.resizer.classList.add('drag');
    el.body.classList.add('resizing');
    const rect = el.workspace.getBoundingClientRect();
    const move = ev => {
      const pct = Math.min(85, Math.max(15, ((ev.clientX - rect.left) / rect.width) * 100));
      settings.split = Math.round(pct * 10) / 10;
      el.editorPane.style.flexBasis = settings.split + '%';
    };
    const up = () => {
      el.resizer.removeEventListener('pointermove', move);
      el.resizer.removeEventListener('pointerup', up);
      el.resizer.classList.remove('drag');
      el.body.classList.remove('resizing');
      saveSettings();
      anchorCache = null;
      cm.refresh();
    };
    el.resizer.addEventListener('pointermove', move);
    el.resizer.addEventListener('pointerup', up);
  });
  el.resizer.addEventListener('dblclick', () => { settings.split = 50; saveSettings(); applyLayout(); });

  // =====================================================================
  // Scroll sync
  // =====================================================================
  let anchorCache = null;
  let activePane = 'editor';
  function getAnchors() {
    if (anchorCache) return anchorCache;
    const raw = [{ line: 0, top: 0 }];
    for (const n of el.preview.children) {
      if (n.classList.contains('ln')) raw.push({ line: +n.dataset.line, top: n.offsetTop });
    }
    const last = el.preview.lastElementChild;
    raw.push({ line: cm.lineCount(), top: last ? last.offsetTop + last.offsetHeight : 0 });
    const list = [];
    for (const a of raw) {
      const p = list[list.length - 1];
      if (!p || (a.line > p.line && a.top >= p.top)) list.push(a);
    }
    return anchorCache = list;
  }

  function editorLineAtTop() {
    const top = cm.getScrollInfo().top;
    const ln = cm.lineAtHeight(top, 'local');
    const y0 = cm.heightAtLine(ln, 'local');
    const y1 = ln + 1 < cm.lineCount() ? cm.heightAtLine(ln + 1, 'local') : y0 + cm.defaultTextHeight();
    return ln + Math.max(0, Math.min(1, (top - y0) / ((y1 - y0) || 1)));
  }

  function syncFromEditor() {
    if (!settings.syncScroll || settings.mode !== 'split') return;
    const L = editorLineAtTop();
    const as = getAnchors();
    let i = 0;
    while (i < as.length - 2 && as[i + 1].line <= L) i++;
    const a = as[i], b = as[i + 1] || a;
    const t = b.line > a.line ? (L - a.line) / (b.line - a.line) : 0;
    el.previewPane.scrollTop = a.top + Math.min(1, Math.max(0, t)) * (b.top - a.top);
  }

  function syncFromPreview() {
    if (!settings.syncScroll || settings.mode !== 'split') return;
    const y = el.previewPane.scrollTop;
    const as = getAnchors();
    let i = 0;
    while (i < as.length - 2 && as[i + 1].top <= y) i++;
    const a = as[i], b = as[i + 1] || a;
    const t = b.top > a.top ? (y - a.top) / (b.top - a.top) : 0;
    const L = a.line + Math.min(1, Math.max(0, t)) * (b.line - a.line);
    const ln = Math.min(cm.lastLine(), Math.floor(L));
    const y0 = cm.heightAtLine(ln, 'local');
    const y1 = ln + 1 < cm.lineCount() ? cm.heightAtLine(ln + 1, 'local') : y0 + cm.defaultTextHeight();
    cm.scrollTo(null, y0 + (L - ln) * (y1 - y0));
  }

  let syncRaf = 0;
  const schedule = fn => { cancelAnimationFrame(syncRaf); syncRaf = requestAnimationFrame(fn); };
  cm.on('scroll', () => { if (activePane === 'editor') schedule(syncFromEditor); });
  el.previewPane.addEventListener('scroll', () => { if (activePane === 'preview') schedule(syncFromPreview); }, { passive: true });
  for (const [pane, name] of [[el.editorPane, 'editor'], [el.previewPane, 'preview']]) {
    for (const ev of ['mouseenter', 'wheel', 'touchstart', 'pointerdown']) pane.addEventListener(ev, () => { activePane = name; }, { passive: true });
  }
  cm.on('focus', () => { activePane = 'editor'; });
  cm.on('keydown', () => { activePane = 'editor'; });
  el.preview.addEventListener('load', () => { anchorCache = null; }, true);
  window.addEventListener('resize', () => { anchorCache = null; });

  // =====================================================================
  // Outline
  // =====================================================================
  let outlineItems = [];
  function buildOutline() {
    outlineItems = [];
    for (const h of $$(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6', el.preview)) {
      const prev = h.previousElementSibling;
      outlineItems.push({ level: +h.tagName[1], text: headingText(h), id: h.id, line: prev && prev.classList.contains('ln') ? +prev.dataset.line : 0, el: h });
    }
    el.outline.innerHTML = outlineItems.length ? '' : '<li class="empty">No headings yet</li>';
    const min = Math.min(...outlineItems.map(o => o.level));
    outlineItems.forEach((o, i) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.dataset.i = i;
      a.textContent = o.text || '(untitled)';
      a.style.paddingLeft = 8 + (o.level - min) * 14 + 'px';
      if (o.level === min) a.style.fontWeight = '600';
      li.append(a);
      el.outline.append(li);
    });
    highlightOutline();
  }
  function highlightOutline() {
    const line = cm.getCursor().line;
    let cur = -1;
    outlineItems.forEach((o, i) => { if (o.line <= line) cur = i; });
    $$('a', el.outline).forEach(a => a.classList.toggle('cur', +a.dataset.i === cur));
  }
  el.outline.addEventListener('click', e => {
    const a = e.target.closest('a[data-i]');
    if (!a) return;
    e.preventDefault();
    const o = outlineItems[+a.dataset.i];
    if (!o) return;
    activePane = null;
    if (settings.mode !== 'preview') {
      cm.setCursor(pos(o.line, 0));
      cm.scrollTo(null, cm.heightAtLine(o.line, 'local') - 8);
    }
    if (settings.mode !== 'edit' && o.el.isConnected) {
      el.previewPane.scrollTop = o.el.offsetTop - 12;
      o.el.classList.remove('flash'); void o.el.offsetWidth; o.el.classList.add('flash');
    }
    if (settings.mode !== 'preview') cm.focus();
    setTimeout(() => { activePane = settings.mode === 'preview' ? 'preview' : 'editor'; }, 100);
  });

  // =====================================================================
  // Preview interactions
  // =====================================================================
  function taskLines() {
    const text = cm.getValue();
    const fm = FM_RE.exec(text);
    const start = fm ? countNL(fm[0]) : 0;
    const out = [];
    eachProseLine(text, (l, i) => { if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(l)) out.push(i); }, start);
    return out;
  }

  el.preview.addEventListener('click', e => {
    const cb = e.target.closest('input.task');
    if (cb) {
      const line = taskLines()[+cb.dataset.task];
      if (line == null) { e.preventDefault(); return; }
      const l = cm.getLine(line);
      const n = l.replace(/\[([ xX])\]/, (_, c) => c === ' ' ? '[x]' : '[ ]');
      cm.replaceRange(n, pos(line, 0), pos(line, l.length));
      render();
      return;
    }
    const copy = e.target.closest('.copy-code');
    if (copy) {
      const code = copy.parentElement.querySelector('code');
      navigator.clipboard.writeText(code ? code.textContent : '').then(() => {
        copy.textContent = 'Copied!';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      }, () => toast('Clipboard not available'));
      return;
    }
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        const target = el.preview.querySelector(`[id="${CSS.escape(id)}"]`);
        if (target) {
          activePane = 'preview';
          el.previewPane.scrollTop = target.offsetTop - 12;
          target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
        }
      } else if (/^(https?:|mailto:|ftp:)/i.test(href)) {
        window.open(href, '_blank', 'noopener');
      } else {
        toast(`Relative link: ${href}`);
      }
    }
  });

  el.preview.addEventListener('dblclick', e => {
    if (e.target.closest('a, input, button, summary')) return;
    const y = e.clientY - el.previewPane.getBoundingClientRect().top + el.previewPane.scrollTop;
    const as = getAnchors();
    let i = 0;
    while (i < as.length - 2 && as[i + 1].top <= y) i++;
    const line = Math.min(cm.lastLine(), as[i].line);
    if (settings.mode === 'preview') setMode('split');
    activePane = null;
    cm.setCursor(pos(line, 0));
    const h = cm.heightAtLine(line, 'local');
    cm.scrollTo(null, h - cm.getScrollInfo().clientHeight / 3);
    cm.focus();
    setTimeout(() => { activePane = 'editor'; }, 100);
  });

  // =====================================================================
  // Find & replace
  // =====================================================================
  const findState = { open: false, caseSensitive: false, word: false, regex: false, matches: [], cur: -1, marks: [], curMark: null };

  function buildRegex() {
    const q = el.findInput.value;
    if (!q) return null;
    let src = findState.regex ? q : escapeRe(q);
    if (findState.word) src = `\\b(?:${src})\\b`;
    try { return new RegExp(src, 'gm' + (findState.caseSensitive ? '' : 'i') + 'u'); } catch { return 'bad'; }
  }

  function clearFindMarks() {
    findState.marks.forEach(m => m.clear());
    findState.marks = [];
    if (findState.curMark) { findState.curMark.clear(); findState.curMark = null; }
  }

  function runFind(keepCur = false) {
    clearFindMarks();
    findState.matches = [];
    const re = buildRegex();
    el.findInput.classList.toggle('bad', re === 'bad');
    if (!re || re === 'bad') { findState.cur = -1; updateFindCount(); return; }
    const text = cm.getValue();
    let m;
    while ((m = re.exec(text)) && findState.matches.length < 10000) {
      if (!m[0].length) { re.lastIndex++; continue; }
      findState.matches.push([m.index, m.index + m[0].length]);
    }
    cm.operation(() => {
      for (const [s, e] of findState.matches.slice(0, 3000)) {
        findState.marks.push(cm.markText(cm.posFromIndex(s), cm.posFromIndex(e), { className: 'cm-find-hit' }));
      }
    });
    if (!keepCur || findState.cur >= findState.matches.length) {
      const ci = cm.indexFromPos(cm.getCursor('from'));
      findState.cur = findState.matches.findIndex(([s]) => s >= ci);
      if (findState.cur < 0 && findState.matches.length) findState.cur = 0;
    }
    highlightCurrent(false);
    updateFindCount();
  }

  function highlightCurrent(select) {
    if (findState.curMark) { findState.curMark.clear(); findState.curMark = null; }
    const m = findState.matches[findState.cur];
    if (!m) return;
    const from = cm.posFromIndex(m[0]), to = cm.posFromIndex(m[1]);
    findState.curMark = cm.markText(from, to, { className: 'cm-find-cur' });
    if (select) cm.setSelection(from, to);
    cm.scrollIntoView({ from, to }, 80);
  }

  function updateFindCount() {
    const n = findState.matches.length;
    el.findCount.textContent = !el.findInput.value ? '' : n ? `${findState.cur + 1} of ${n}${n >= 10000 ? '+' : ''}` : 'No results';
  }

  function findStep(dir) {
    const n = findState.matches.length;
    if (!n) return;
    findState.cur = (findState.cur + dir + n) % n;
    highlightCurrent(true);
    updateFindCount();
  }

  function replaceText(match) {
    const repl = el.replaceInput.value;
    if (!findState.regex) return repl;
    const re = buildRegex();
    return match.replace(new RegExp(re.source, re.flags.replace('g', '')), repl);
  }

  function replaceOne() {
    const m = findState.matches[findState.cur];
    if (!m) return;
    const from = cm.posFromIndex(m[0]), to = cm.posFromIndex(m[1]);
    const r = replaceText(cm.getRange(from, to));
    cm.replaceRange(r, from, to, '+replace');
    cm.setCursor(cm.posFromIndex(m[0] + r.length));
    runFind();
    highlightCurrent(true);
  }

  function replaceAll() {
    const ms = findState.matches;
    if (!ms.length) return;
    const text = cm.getValue();
    let out = '', last = 0;
    for (const [s, e] of ms) { out += text.slice(last, s) + replaceText(text.slice(s, e)); last = e; }
    out += text.slice(last);
    const c = cm.getCursor();
    cm.operation(() => {
      cm.replaceRange(out, pos(0, 0), pos(cm.lastLine(), cm.getLine(cm.lastLine()).length), '+replace');
      cm.setCursor(c);
    });
    toast(`Replaced ${ms.length} occurrence${ms.length === 1 ? '' : 's'}`);
    runFind();
  }

  function openFind(replace) {
    if (settings.mode === 'preview') setMode('split');
    findState.open = true;
    el.findbar.hidden = false;
    const sel = cm.getSelection();
    if (sel && !sel.includes('\n')) el.findInput.value = sel;
    runFind();
    const input = replace ? el.replaceInput : el.findInput;
    input.focus();
    input.select();
  }
  function closeFind() {
    findState.open = false;
    el.findbar.hidden = true;
    clearFindMarks();
    const m = findState.matches[findState.cur];
    if (m) cm.setSelection(cm.posFromIndex(m[0]), cm.posFromIndex(m[1]));
    cm.focus();
  }

  el.findInput.addEventListener('input', () => runFind());
  el.findInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  el.replaceInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.ctrlKey && e.altKey) replaceAll(); else replaceOne(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  for (const [btn, key] of [[el.findCase, 'caseSensitive'], [el.findWord, 'word'], [el.findRegex, 'regex']]) {
    btn.addEventListener('click', () => { findState[key] = !findState[key]; btn.classList.toggle('on', findState[key]); runFind(); el.findInput.focus(); });
  }
  $('#find-next', el.findbar).addEventListener('click', () => findStep(1));
  $('#find-prev', el.findbar).addEventListener('click', () => findStep(-1));
  $('#find-close', el.findbar).addEventListener('click', closeFind);
  $('#replace-one', el.findbar).addEventListener('click', replaceOne);
  $('#replace-all', el.findbar).addEventListener('click', replaceAll);
  const refind = debounce(() => { if (findState.open) runFind(true); }, 200);

  // =====================================================================
  // Editor events
  // =====================================================================
  function updateStats() {
    const text = cm.getValue();
    const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
    el.stWords.textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}`;
    el.stChars.textContent = `${text.length.toLocaleString()} chars`;
    el.stRead.textContent = `${Math.max(1, Math.round(words / 230))} min read`;
  }
  const updateStatsSoon = debounce(updateStats, 250);

  function updateCursorStatus() {
    const c = cm.getCursor();
    el.stPos.textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
    const sel = cm.getSelection();
    if (sel) {
      const w = (sel.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
      el.stSel.textContent = `(${sel.length} selected, ${w} word${w === 1 ? '' : 's'})`;
    } else el.stSel.textContent = '';
  }

  cm.on('changes', () => {
    if (!current) return;
    current.updated = Date.now();
    if (current.handle && !suppressDirty && !current.fileDirty) { current.fileDirty = true; renderDocList(); }
    updateSaveStatus('saving');
    persist();
    renderSoon();
    updateStatsSoon();
    refind();
  });

  const outlineSoon = debounce(highlightOutline, 150);
  cm.on('cursorActivity', () => {
    updateCursorStatus();
    updateMathBarSoon();
    outlineSoon();
    if (settings.typewriter && cm.hasFocus()) {
      const c = cm.cursorCoords(null, 'local');
      cm.scrollTo(null, c.top - cm.getScrollInfo().clientHeight / 2);
    }
  });

  cm.on('swapDoc', updateMathBarSoon);

  cm.on('paste', (_, e) => {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (img) {
      e.preventDefault();
      insertImageFile(img.getAsFile());
      return;
    }
    const text = e.clipboardData?.getData('text/plain') || '';
    const sel = cm.getSelection();
    if (sel && !sel.includes('\n') && /^https?:\/\/\S+$/.test(text.trim()) && !/^https?:\/\//.test(sel)) {
      e.preventDefault();
      cm.replaceSelection(`[${sel}](${text.trim()})`);
    }
  });

  cm.on('drop', (_, e) => {
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.codemirrorIgnore = true;
  });

  function insertImageFile(file) {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) toast('Large image: it will be embedded in the document as data', 3500);
    const r = new FileReader();
    r.onload = () => {
      const name = (file.name && file.name !== 'image.png') ? stripExt(file.name).replace(/\.[^.]+$/, '') : 'image';
      cm.replaceSelection(`![${name}](${r.result})`);
      cm.focus();
    };
    r.readAsDataURL(file);
  }

  // ---------- Title ----------
  el.title.addEventListener('input', () => {
    if (!current) return;
    current.title = el.title.value.trim() || 'Untitled';
    current.titleLocked = !!el.title.value.trim();
    persist();
    renderDocList();
    updateSaveStatus();
  });
  el.title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); cm.focus(); } });
  el.title.addEventListener('blur', () => { if (!el.title.value.trim() && current) { current.titleLocked = false; flushSave(); el.title.value = current.title; } });

  // =====================================================================
  // UI wiring
  // =====================================================================
  function closeMenus() { $$('.menu-list.open').forEach(m => m.classList.remove('open')); }

  document.addEventListener('click', e => {
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) {
      const list = document.getElementById(menuBtn.dataset.menu);
      const wasOpen = list.classList.contains('open');
      closeMenus();
      if (!wasOpen) list.classList.add('open');
      return;
    }
    const cmdBtn = e.target.closest('[data-cmd]');
    if (cmdBtn) {
      closeMenus();
      run(cmdBtn.dataset.cmd, cmdBtn.dataset.arg);
      return;
    }
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) { setMode(modeBtn.dataset.mode); return; }
    const sideBtn = e.target.closest('[data-side]');
    if (sideBtn) { settings.sideTab = sideBtn.dataset.side; saveSettings(); applyLayout(); return; }
    if (!e.target.closest('.menu-list')) closeMenus();
  });

  // Keep editor selection when clicking formatting buttons
  $('#fmt-group').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });

  el.docList.addEventListener('click', e => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.closest('.x')) { deleteDocument(li.dataset.id); return; }
    switchTo(li.dataset.id);
  });
  el.docSearch.addEventListener('input', renderDocList);

  el.fileInput.addEventListener('change', async () => {
    for (const f of el.fileInput.files) await openPlainFile(f);
    el.fileInput.value = '';
  });

  // ---------- Global keyboard shortcuts ----------
  const GLOBAL_KEYS = {
    'Ctrl+KeyS': 'save', 'Ctrl+Shift+KeyS': 'saveAs', 'Ctrl+KeyO': 'openFile', 'Ctrl+Alt+KeyN': 'newDoc',
    'Ctrl+Alt+Digit1': ['setMode', 'edit'], 'Ctrl+Alt+Digit2': ['setMode', 'split'], 'Ctrl+Alt+Digit3': ['setMode', 'preview'],
    'Ctrl+Alt+KeyM': 'cycleMode', 'Ctrl+Backslash': 'toggleSidebar', 'Ctrl+Shift+KeyF': 'focusMode',
    'Ctrl+KeyF': 'find', 'Ctrl+KeyH': 'replace', 'F1': 'help', 'Ctrl+Slash': 'help',
  };
  const EDITOR_KEYS = {
    'Ctrl+KeyB': 'bold', 'Ctrl+KeyI': 'italic', 'Ctrl+Shift+KeyX': 'strike', 'Ctrl+KeyK': 'link', 'Ctrl+Backquote': 'code',
    'Ctrl+Alt+KeyC': 'codeBlock', 'Ctrl+Shift+KeyH': ['heading', 'cycle'], 'Ctrl+Shift+Period': 'quote', 'Ctrl+Shift+KeyL': 'toggleTask',
    'Ctrl+Alt+KeyT': 'formatTable', 'Ctrl+KeyD': 'duplicate', 'Alt+ArrowUp': 'moveUp', 'Alt+ArrowDown': 'moveDown',
  };

  window.addEventListener('keydown', e => {
    const combo = (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
    if (e.key === 'Escape') {
      if ($('.menu-list.open')) { closeMenus(); return; }
      if (mathbar.shown && cm.hasFocus() && !findState.open) { mathbar.dismissed = true; updateMathBar(); return; }
      if (findState.open && el.findbar.contains(document.activeElement)) return;
      if (findState.open && cm.hasFocus()) { e.preventDefault(); closeFind(); return; }
      if (el.body.classList.contains('focus')) { el.body.classList.remove('focus'); cm.refresh(); return; }
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    let action = GLOBAL_KEYS[combo];
    if (!action && cm.hasFocus()) action = EDITOR_KEYS[combo];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    const [name, arg] = Array.isArray(action) ? action : [action];
    run(name, arg);
  }, true);

  // ---------- Drag & drop files ----------
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const isTextFile = f => /\.(md|markdown|mdown|mkd|txt|text)$/i.test(f.name) || f.type.startsWith('text/');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; el.dropzone.hidden = false; } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; el.dropzone.hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.hidden = true;
    // Grab handles synchronously, before any await invalidates the DataTransfer
    const entries = [...e.dataTransfer.items].filter(i => i.kind === 'file').map(i => ({
      file: i.getAsFile(),
      handle: i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null),
    }));
    for (const { file, handle } of entries) {
      if (!file) continue;
      if (file.type.startsWith('image/')) {
        if (settings.mode === 'preview') setMode('split');
        insertImageFile(file);
      } else if (isTextFile(file)) {
        const h = await handle;
        if (h && h.kind === 'file') await openHandle(h); else await openPlainFile(file);
      } else toast(`Can't open ${file.name}`);
    }
  });

  // ---------- Lifecycle ----------
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('focus', checkDiskChange);
  window.addEventListener('beforeunload', e => {
    flushSave();
    if (current && current.fileDirty) { e.preventDefault(); e.returnValue = ''; }
  });
  setInterval(() => { if (settings.sidebar && settings.sideTab === 'docs' && !document.hidden) renderDocList(); }, 60000);

  // =====================================================================
  // Init
  // =====================================================================
  async function init() {
    applySettings(false);
    try {
      docs = (await db.all()) || [];
      const handles = await db.allHandles();
      for (const d of docs) {
        if (d.handle) {
          // Migrate handles stored inside doc records by older versions
          await db.putHandle(d.id, d.handle);
          await db.put(d);
        } else d.handle = handles.get(d.id) || null;
      }
    } catch (e) { console.error(e); docs = []; toast('Browser storage unavailable — documents will not persist', 5000); }
    if (!docs.length) {
      const welcome = makeDoc({ title: 'Welcome', content: el.welcome.textContent.replace(/^\n/, '') });
      docs.push(welcome);
      db.put(welcome).catch(() => {});
    }
    const want = store.get('mde.current', null);
    const start = docs.find(d => d.id === want) || docs.slice().sort((a, b) => b.updated - a.updated)[0];
    await switchTo(start.id);
    updateCursorStatus();
  }
  init();

  // Expose for debugging from the console
  window.mde = { cm, render, settings: () => settings };
})();
