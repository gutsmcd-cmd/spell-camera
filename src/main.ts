import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { createWorker, type Worker as TWorker } from 'tesseract.js'
import { dict, type Lang, type Dict } from './i18n'
import * as db from './db'
import { checkWords, loadSpeller, split, type Dialect, type Word } from './check'

registerSW({ immediate: true })
void db.askPersist()

interface Scan { id: string; created: number; img: Blob; w: number; h: number; words: Word[] }

const S = {
  lang: 'ja' as Lang,
  dialect: 'us' as Dialect,
  personal: new Set<string>(),
  scan: null as Scan | null,
  bmp: null as HTMLImageElement | null,
  sel: -1,
}
const T = (): Dict => dict[S.lang]
const app = document.getElementById('app')!
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | false)[]) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'testid') e.dataset.testid = String(v)
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v
    else e.setAttribute(k, String(v))
  }
  for (const c of kids) if (c) e.append(c)
  return e
}
const toast = (msg: string) => {
  const t = h('div', { className: 'toast' }, msg)
  document.body.append(t)
  setTimeout(() => t.remove(), 1800)
}

// ---------- OCR ----------
let worker: Promise<TWorker> | null = null
let progressCb: (s: string, p: number) => void = () => {}
function getWorker() {
  if (!worker) {
    const base = new URL('./tesseract/', location.href).href
    worker = createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      workerBlobURL: false,
      logger: (m: { status: string; progress: number }) => progressCb(m.status, m.progress),
    })
    worker.catch(() => { worker = null })
  }
  return worker
}

async function ocr(canvas: HTMLCanvasElement): Promise<Word[]> {
  const wk = await getWorker()
  const run = async (psm: string) => {
    await wk.setParameters({ tessedit_pageseg_mode: psm as never, preserve_interword_spaces: '1', user_defined_dpi: '300' })
    const { data } = await wk.recognize(canvas, {}, { blocks: true, text: true })
    const out: Word[] = []
    let line = 0
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
      for (const w of l.words) {
        const t = w.text.trim()
        if (!t) continue
        out.push({ text: t, ...split(t), conf: w.confidence, bbox: w.bbox, line, kind: 'ok', sugg: [] })
      }
      line++
    }
    return out
  }
  let words = await run('3')
  if (words.filter((w) => /[A-Za-z]{2}/.test(w.core)).length < 2) {
    const sparse = await run('11')
    if (sparse.length > words.length) words = sparse
  }
  // drop junk: tiny low-confidence fragments without letters
  return words.filter((w) => /[A-Za-z0-9]/.test(w.text) && !(w.conf < 20 && w.core.length < 3))
}

async function personalLoad() {
  const p = await db.get<string[]>('kv', 'personal')
  S.personal = new Set(p ?? [])
}

// ---------- Flow ----------
function status(msg: string, sub = '') {
  let el = document.querySelector<HTMLElement>('.status')
  if (!el) { el = h('div', { className: 'status', testid: 'status' }); document.body.append(el) }
  el.hidden = !msg
  el.replaceChildren(h('div', { className: 'spin' }), h('div', {}, msg), ...(sub ? [h('div', { className: 'small' }, sub)] : []))
}

async function fileToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const max = 2200
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k)
    c.height = Math.round(img.naturalHeight * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c
  } finally { URL.revokeObjectURL(url) }
}

async function analyse(blob: Blob) {
  try {
    const c = await fileToCanvas(blob)
    const firstOcr = !(await db.get('kv', 'ocrReady'))
    progressCb = (s, p) => {
      if (/recogniz/.test(s)) status(T().reading, Math.round(p * 100) + '%')
      else if (firstOcr) status(T().prepOcr, T().firstNote)
    }
    status(firstOcr ? T().prepOcr : T().reading, firstOcr ? T().firstNote : '')
    const sp = loadSpeller(S.dialect)
    const words = await ocr(c)
    await db.put('kv', 'ocrReady', true)
    status(T().prepDict)
    checkWords(await sp, words, S.personal)
    const img = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.88))
    const scan: Scan = { id: Date.now().toString(36), created: Date.now(), img, w: c.width, h: c.height, words }
    if (words.length) await db.put('scans', scan.id, scan)
    status('')
    await openScan(scan)
    if (!words.length) toast(T().noText)
  } catch (e) {
    console.warn(e)
    status('')
    alert(T().fail)
  }
}

async function recheck() {
  if (!S.scan) return
  checkWords(await loadSpeller(S.dialect), S.scan.words, S.personal)
  await db.put('scans', S.scan.id, S.scan)
}

// ---------- Drawing ----------
const COL = { miss: '#ff2e4d', hint: '#ffb020', unsure: '#9aa3ad', fixed: '#22c55e' }
function wordState(w: Word): keyof typeof COL | null {
  if (w.fix !== undefined) return 'fixed'
  if (w.kind === 'miss') return 'miss'
  if (w.kind === 'unsure' && w.sugg.length) return 'unsure'
  if (w.hint) return 'hint'
  if (w.kind === 'unsure') return 'unsure'
  return null
}

function squiggle(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, amp: number) {
  g.beginPath()
  const step = amp * 2
  g.moveTo(x0, y)
  for (let x = x0, up = true; x < x1; x += step, up = !up) g.quadraticCurveTo(x + step / 2, y + (up ? -amp : amp), Math.min(x + step, x1), y)
  g.stroke()
}

function render(canvas: HTMLCanvasElement) {
  const sc = S.scan!, g = canvas.getContext('2d')!
  canvas.width = sc.w; canvas.height = sc.h
  g.drawImage(S.bmp!, 0, 0, sc.w, sc.h)
  sc.words.forEach((w, i) => {
    const st = wordState(w)
    if (!st) return
    const { x0, x1, y0, y1 } = w.bbox
    const hgt = y1 - y0
    const lw = Math.max(2, hgt * 0.09)
    g.lineWidth = lw
    g.strokeStyle = COL[st]
    g.setLineDash([])
    if (i === S.sel) {
      g.fillStyle = COL[st] + '33'
      g.fillRect(x0 - 3, y0 - 3, x1 - x0 + 6, hgt + 6)
    }
    const y = y1 + lw * 1.6
    if (st === 'unsure') {
      g.setLineDash([lw, lw * 1.6])
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke()
    } else if (st === 'fixed') {
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke()
      const fs = Math.max(12, hgt * 0.5)
      g.font = `700 ${fs}px system-ui, sans-serif`
      const label = w.fix || '⌫'
      const tw = g.measureText(label).width + 8
      g.fillStyle = COL.fixed
      g.fillRect(x0, y0 - fs - 6, tw, fs + 4)
      g.fillStyle = '#fff'
      g.fillText(label, x0 + 4, y0 - 6)
    } else squiggle(g, x0, x1, y, lw * 1.3)
  })
}

// ---------- Views ----------
function header(onToggle: () => void) {
  return h('div', { className: 'top' },
    h('h1', {}, T().app),
    h('button', { className: 'ghost', testid: 'lang', onclick: async () => { S.lang = S.lang === 'ja' ? 'en' : 'ja'; await db.put('kv', 'lang', S.lang); document.documentElement.lang = S.lang; onToggle() } }, T().toggle))
}

function fileInput(capture: boolean) {
  const i = h('input', { type: 'file', accept: 'image/*', hidden: true }) as HTMLInputElement
  if (capture) i.setAttribute('capture', 'environment')
  i.onchange = () => { const f = i.files?.[0]; if (f) void analyse(f); i.value = '' }
  return i
}

async function home() {
  S.scan = null
  const t = T()
  const shoot = fileInput(true), pick = fileInput(false)
  const dialects = h('div', { className: 'seg', role: 'group' },
    ...(['us', 'gb'] as Dialect[]).map((d) => h('button', { className: S.dialect === d ? 'on' : '', testid: 'dict-' + d, onclick: async () => { S.dialect = d; await db.put('kv', 'dialect', d); void home(); void loadSpeller(d).catch(() => {}) } }, t[d])))
  const list = h('div', { className: 'hist', testid: 'history' })
  const scans = (await db.all<Scan>('scans')).sort((a, b) => b.created - a.created)
  if (!scans.length) list.append(h('p', { className: 'small' }, t.none))
  for (const s of scans) {
    const url = URL.createObjectURL(s.img)
    const errs = s.words.filter((w) => w.kind === 'miss').length
    const excerpt = s.words.slice(0, 8).map((w) => w.text).join(' ')
    list.append(h('div', { className: 'hrow' },
      h('img', { src: url, alt: '', onclick: () => openScan(s) }),
      h('div', { className: 'hmeta', onclick: () => openScan(s) },
        h('div', { className: 'hex' }, excerpt),
        h('div', { className: 'small' }, new Date(s.created).toLocaleString(S.lang === 'ja' ? 'ja-JP' : 'en-GB'), ' · ', h('span', { className: errs ? 'bad' : 'good' }, errs ? `✗ ${errs}` : '✓'))),
      h('button', { className: 'icon sm danger', 'aria-label': t.del, onclick: async () => { if (confirm(t.delQ)) { await db.del('scans', s.id); void home() } } }, '🗑')))
  }
  app.replaceChildren(
    header(home),
    h('p', { className: 'lead' }, t.lead),
    h('div', { className: 'home' },
      h('button', { className: 'big primary', testid: 'shoot', onclick: () => shoot.click() }, t.shoot),
      h('button', { className: 'big', testid: 'pick', onclick: () => pick.click() }, t.pick),
      h('button', { className: 'big', testid: 'live', onclick: live }, t.live),
      shoot, pick,
      h('div', { className: 'row' }, h('span', { className: 'small' }, t.dictLabel), dialects),
      h('h2', {}, t.history), list,
      h('p', { className: 'foot' }, t.foot), h('p', { className: 'foot' }, t.credit)))
}

async function live() {
  const t = T()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
  } catch { alert(t.camFail); return }
  const v = h('video', { autoplay: true, playsInline: true, muted: true }) as HTMLVideoElement
  v.srcObject = stream
  const stop = () => { stream.getTracks().forEach((x) => x.stop()); ov.remove() }
  const ov = h('div', { className: 'cam' }, v,
    h('div', { className: 'cambar' },
      h('button', { className: 'big', onclick: stop }, t.close),
      h('button', { className: 'big primary', testid: 'snap', onclick: () => {
        const c = document.createElement('canvas')
        c.width = v.videoWidth; c.height = v.videoHeight
        c.getContext('2d')!.drawImage(v, 0, 0)
        stop()
        c.toBlob((b) => b && analyse(b), 'image/jpeg', 0.92)
      } }, t.snap)))
  document.body.append(ov)
}

function correctedText(sc: Scan) {
  const lines: string[] = []
  for (const w of sc.words) {
    const piece = w.fix !== undefined ? (w.fix ? w.pre + w.fix + w.post : '') : w.text
    if (!piece) continue
    lines[w.line] = lines[w.line] ? lines[w.line] + ' ' + piece : piece
  }
  return lines.filter((l) => l !== undefined).join('\n')
}

async function openScan(sc: Scan) {
  S.scan = sc
  S.sel = -1
  const img = new Image()
  const url = URL.createObjectURL(sc.img)
  img.src = url
  await img.decode()
  S.bmp = img
  if (!sc.words.length) { void home(); return }
  view()
}

function view() {
  const sc = S.scan!, t = T()
  const canvas = h('canvas', { className: 'stage', testid: 'stage' }) as HTMLCanvasElement
  render(canvas)
  const bubble = h('div', { className: 'bubble', testid: 'bubble', hidden: true })
  const panel = h('div', { className: 'textpanel', testid: 'text' })
  const miss = sc.words.filter((w) => w.kind === 'miss' && w.fix === undefined).length
  const hints = sc.words.filter((w) => w.hint && w.kind !== 'miss' && w.fix === undefined).length
  const uns = sc.words.filter((w) => w.kind === 'unsure' && w.fix === undefined).length
  const sum = h('p', { className: 'summary', testid: 'summary' }, miss + hints + uns ? t.summary(miss, hints, uns) : t.allGood)

  const choose = (i: number, fix: string | undefined) => { sc.words[i].fix = fix; S.sel = -1; void db.put('scans', sc.id, sc); view() }

  const showBubble = (i: number, anchor?: { x: number; y: number }) => {
    S.sel = i
    render(canvas)
    const w = sc.words[i]
    const st = wordState(w)
    const items: (Node | string)[] = [h('div', { className: 'bword' }, w.core)]
    if (w.fix !== undefined) items.push(h('button', { className: 'tiny', testid: 'undo-fix', onclick: () => choose(i, undefined) }, t.undoFix))
    else {
      let sugg = w.sugg
      if (w.kind === 'miss' || (w.kind === 'unsure' && w.sugg.length)) {
        if (w.kind === 'unsure') items.push(h('p', { className: 'small' }, t.unsureNote))
      } else if (w.hint) {
        items.push(h('p', { className: 'small' }, '💡 ' + (t.hints[w.hint.code] ?? '') + ' ' + t.hintNote))
        sugg = w.hint.sugg
      } else if (w.kind === 'unsure') items.push(h('p', { className: 'small' }, t.unsureNote))
      if (w.kind === 'romaji') items.push(h('p', { className: 'small' }, t.romajiNote))
      if (sugg.length) items.push(h('div', { className: 'small' }, t.sugg), h('div', { className: 'chips', testid: 'suggestions' },
        ...sugg.map((s) => h('button', { className: 'chip', onclick: () => choose(i, s) }, s || t.remove))))
      else if (st === 'miss') items.push(h('p', { className: 'small' }, t.noSugg))
      if (w.kind === 'miss' || w.kind === 'unsure') items.push(h('button', { className: 'tiny ghost', testid: 'add-word', onclick: async () => {
        S.personal.add(w.core.toLowerCase()); await db.put('kv', 'personal', [...S.personal]); await recheck(); S.sel = -1; view()
      } }, t.addWord))
    }
    items.push(h('button', { className: 'tiny ghost bx', 'aria-label': t.close, onclick: () => { bubble.hidden = true; S.sel = -1; render(canvas) } }, '✕'))
    bubble.replaceChildren(...items)
    bubble.hidden = false
    if (anchor) { bubble.style.left = Math.max(8, Math.min(anchor.x - 120, innerWidth - 268)) + 'px'; bubble.style.top = anchor.y + 12 + scrollY + 'px' }
    else { bubble.style.left = '50%'; bubble.style.top = (canvas.getBoundingClientRect().bottom + scrollY - 40) + 'px'; bubble.style.transform = 'translateX(-50%)' }
    if (anchor) bubble.style.transform = ''
  }

  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * sc.w, y = ((e.clientY - r.top) / r.height) * sc.h
    const pad = 0.02 * sc.w
    let best = -1, bd = Infinity
    sc.words.forEach((w, i) => {
      if (!wordState(w) && w.kind !== 'romaji') return
      const b = w.bbox
      const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - (b.y1 + (b.y1 - b.y0) * 0.4))
      const d = Math.hypot(dx, dy)
      if (d < pad && d < bd) { bd = d; best = i }
    })
    if (best >= 0) showBubble(best, { x: e.clientX, y: e.clientY })
    else { bubble.hidden = true; S.sel = -1; render(canvas) }
  }

  // text panel
  let curLine = -1, lineEl: HTMLElement | null = null
  sc.words.forEach((w, i) => {
    if (w.line !== curLine) { curLine = w.line; lineEl = h('div', { className: 'tline' }); panel.append(lineEl) }
    const st = wordState(w)
    const shown = w.fix !== undefined ? w.pre + (w.fix || '') + w.post : w.text
    const span = h('span', { className: 'tw ' + (st ?? '') + (w.kind === 'romaji' ? ' romaji' : ''), testid: st ? 'tw-' + st : 'tw' }, shown)
    if (st || w.kind === 'romaji') span.onclick = () => { const r = span.getBoundingClientRect(); showBubble(i, { x: r.left + r.width / 2, y: r.bottom }) }
    lineEl!.append(span, ' ')
  })

  const exportBlob = () => new Promise<Blob>((res) => { S.sel = -1; render(canvas); canvas.toBlob((b) => res(b!), 'image/png') })
  const dl = (b: Blob) => { const a = h('a', { href: URL.createObjectURL(b), download: `spell-check-${sc.id}.png` }); a.click() }

  app.replaceChildren(
    h('div', { className: 'ebar' },
      h('button', { className: 'ghost', testid: 'back', onclick: home }, t.back),
      h('button', { className: 'ghost', onclick: async () => { S.lang = S.lang === 'ja' ? 'en' : 'ja'; await db.put('kv', 'lang', S.lang); view() } }, t.toggle)),
    sum,
    h('div', { className: 'legend' },
      h('span', { className: 'lg miss' }, t.lgMiss), h('span', { className: 'lg hint' }, t.lgHint),
      h('span', { className: 'lg unsure' }, t.lgUnsure), h('span', { className: 'lg fixed' }, t.lgFixed)),
    h('div', { className: 'stagewrap' }, canvas),
    bubble,
    h('h2', {}, t.text), panel,
    h('div', { className: 'actions' },
      h('button', { className: 'big', testid: 'fix-all', onclick: () => {
        sc.words.forEach((w) => { if (w.fix === undefined) { if (w.kind === 'miss' && w.sugg[0]) w.fix = w.sugg[0]; else if (w.kind !== 'miss' && w.hint && w.kind !== 'unsure') w.fix = w.hint.sugg[0] } })
        void db.put('scans', sc.id, sc); view()
      } }, t.fixAll),
      h('button', { className: 'big primary', testid: 'copy', onclick: async () => {
        const txt = correctedText(sc)
        try { await navigator.clipboard.writeText(txt) } catch { prompt('', txt); return }
        toast(t.copied)
      } }, t.copy),
      h('button', { className: 'big', testid: 'share', onclick: async () => {
        const b = await exportBlob()
        const f = new File([b], `spell-check-${sc.id}.png`, { type: 'image/png' })
        if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f] }) } catch { /* cancelled */ } } else dl(b)
      } }, t.share),
      h('button', { className: 'big', testid: 'save', onclick: async () => dl(await exportBlob()) }, t.saveImg)))
}

// expose for tests
;(window as unknown as Record<string, unknown>).__spell = { S, correctedText }

;(async () => {
  S.lang = (await db.get<Lang>('kv', 'lang')) ?? 'ja'
  S.dialect = (await db.get<Dialect>('kv', 'dialect')) ?? 'us'
  document.documentElement.lang = S.lang
  await personalLoad()
  void home()
})()
