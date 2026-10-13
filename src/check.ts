// Offline spell + light grammar checks. Dictionaries (Hunspell en_US / en_GB, via nspell) are fetched
// once from jsDelivr and kept in the service-worker cache.
import nspell from 'nspell'

export type Dialect = 'us' | 'gb'
export type Kind = 'ok' | 'miss' | 'unsure' | 'romaji' | 'skip'
export interface Hint { code: string; sugg: string[]; arg?: string }
export interface Word {
  text: string // raw OCR token
  pre: string
  core: string
  post: string
  conf: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
  line: number
  kind: Kind
  sugg: string[]
  hint?: Hint
  fix?: string // replacement chosen by the user (for core)
}

const DICT_URL: Record<Dialect, string> = {
  us: 'https://cdn.jsdelivr.net/npm/dictionary-en@4.0.0/',
  gb: 'https://cdn.jsdelivr.net/npm/dictionary-en-gb@3.0.0/',
}
const spellers: Partial<Record<Dialect, Promise<ReturnType<typeof nspell>>>> = {}

export function loadSpeller(d: Dialect) {
  if (!spellers[d]) {
    spellers[d] = (async () => {
      const get = async (f: string) => {
        const r = await fetch(DICT_URL[d] + f)
        if (!r.ok) throw new Error('dict ' + r.status)
        return r.text()
      }
      const [aff, dic] = await Promise.all([get('index.aff'), get('index.dic')])
      const sp = nspell(aff, dic)
      for (const w of EXTRA) sp.add(w)
      return sp
    })()
    spellers[d]!.catch(() => { delete spellers[d] })
  }
  return spellers[d]!
}

// Words that often appear on signs/menus in Japan and are fine in English text.
const EXTRA = (
  'ramen udon soba sushi sashimi tempura tonkatsu katsu karaage gyoza yakitori yakiniku okonomiyaki takoyaki ' +
  'onigiri bento donburi gyudon oyakodon katsudon miso matcha sake shochu umeshu highball izakaya ryokan onsen ' +
  'sento konbini yen wasabi edamame tofu natto mochi dango taiyaki wagyu shabu sukiyaki teppanyaki omakase ' +
  'kaiseki tatami futon yukata kimono shinkansen jr koban ikebukuro shinjuku shibuya umeda namba osaka kyoto tokyo ' +
  'wifi wi-fi takeout ok okay emoji kawaii manga anime gachapon purikura pachinko karaoke'
).split(' ')

const ROMAJI = /^(?:(?:ky|gy|sh|ch|ny|hy|by|py|my|ry|ts|j|f|[kgsztdnhbpmyrw])?[aiueo]|n)+$/i

export function split(raw: string) {
  const m = raw.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/s)!
  return { pre: m[1], core: m[2], post: m[3] }
}

const matchCase = (src: string, s: string) =>
  src.length > 1 && src === src.toUpperCase() ? s.toUpperCase()
    : src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase() ? s[0].toUpperCase() + s.slice(1)
    : s

// Engrish-aware candidates: l/r and b/v mix-ups, si/shi, missing final e.
function engrishCandidates(w: string): string[] {
  const out = new Set<string>()
  const lw = w.toLowerCase()
  for (let i = 0; i < lw.length; i++) {
    const c = lw[i]
    const sw = c === 'l' ? 'r' : c === 'r' ? 'l' : c === 'b' ? 'v' : c === 'v' ? 'b' : ''
    if (sw) out.add(lw.slice(0, i) + sw + lw.slice(i + 1))
  }
  out.add(lw + 'e')
  if (lw.endsWith('u')) out.add(lw.slice(0, -1))
  if (lw.endsWith('o')) out.add(lw.slice(0, -1))
  return [...out]
}

// Real words that are usually Engrish on Japanese menus/signs.
const REAL_WORD_ENGRISH: Record<string, string> = {
  flied: 'fried', viking: 'buffet', toilette: 'toilet',
}

export type Speller = Awaited<ReturnType<typeof loadSpeller>>

export function isCorrect(sp: Speller, w: string, personal: Set<string>): boolean {
  if (personal.has(w.toLowerCase())) return true
  if (sp.correct(w) || sp.correct(w.toLowerCase())) return true
  const cap = w[0].toUpperCase() + w.slice(1).toLowerCase()
  if (sp.correct(cap)) return true
  if (w.includes('-')) return w.split('-').every((p) => !p || isCorrect(sp, p, personal))
  return false
}

export function checkWords(sp: Speller, words: Word[], personal: Set<string>): void {
  for (const w of words) {
    w.sugg = []
    w.hint = undefined
    const c = w.core.replace(/[’‘]/g, "'")
    if (!c || /\d/.test(c) || !/[A-Za-z]/.test(c) || c.length < 2 || /[@/\\]|\.(com|jp|net)/i.test(c) || /[^\x00-\x7f]/.test(c)) {
      w.kind = 'skip'
      continue
    }
    if (isCorrect(sp, c, personal)) {
      const e = REAL_WORD_ENGRISH[c.toLowerCase()]
      w.kind = w.conf < 40 ? 'unsure' : 'ok'
      if (e) w.hint = { code: 'engrish', sugg: [matchCase(c, e)] }
      continue
    }
    if (ROMAJI.test(c) && c.length >= 3) {
      w.kind = 'romaji'
      continue
    }
    const base = c.toLowerCase()
    const eng = engrishCandidates(base).filter((x) => sp.correct(x))
    const s = [...new Set([...eng, ...sp.suggest(base)])].slice(0, 5).map((x) => matchCase(c, x))
    w.sugg = s
    w.kind = w.conf < 65 ? 'unsure' : 'miss'
  }
  grammar(words)
}

const VOWEL_SOUND_CONS = /^(hour|honest|honou?r|heir)/i // "an hour"
const CONS_SOUND_VOWEL = /^(uni|use|usu|uti|eu|one|once|ubiq|ure)/i // "a university"
const COMPARATIVE = new Set('more less better worse rather other larger smaller bigger cheaper faster higher lower older younger earlier later'.split(' '))
const ITS_NEXT = new Set('a an the not been very so time ok okay open closed free here there'.split(' '))
const YOUR_NEXT = new Set('welcome going not a an the very so right'.split(' '))
const ABBR = /^(mr|mrs|ms|dr|st|no|vs|etc|e\.g|i\.e|jr|inc|ltd|co|approx|min|max|tel|fax|p)$/i

function grammar(words: Word[]) {
  const seq = words.filter((w) => w.kind !== 'skip' || /[A-Za-z]/.test(w.core))
  for (let i = 0; i < seq.length; i++) {
    const w = seq[i], prev = seq[i - 1], next = seq[i + 1]
    const lc = w.core.toLowerCase().replace(/[’]/g, "'")
    const nlc = next?.core.toLowerCase() ?? ''
    if (w.hint) continue
    if (prev && prev.line === w.line && !prev.post.trim() && lc && lc === prev.core.toLowerCase() && /^[a-z]+$/.test(lc) && lc !== 'had' && lc !== 'that') {
      w.hint = { code: 'repeat', sugg: [''], arg: w.core }
      continue
    }
    if (next && (lc === 'a' || lc === 'an') && /^[a-z]/i.test(next.core) && !/^[A-Z]{2,}$/.test(next.core)) {
      const vowel = (/^[aeiou]/i.test(nlc) && !CONS_SOUND_VOWEL.test(nlc)) || VOWEL_SOUND_CONS.test(nlc)
      if (lc === 'a' && vowel) { w.hint = { code: 'an', sugg: [matchCase(w.core, 'an')] }; continue }
      if (lc === 'an' && !vowel) { w.hint = { code: 'a', sugg: [matchCase(w.core, 'a')] }; continue }
    }
    if (lc === 'its' && ITS_NEXT.has(nlc)) { w.hint = { code: 'its', sugg: [matchCase(w.core, "it's")] }; continue }
    if (lc === "it's" && /^(own|name|colou?r|size|shape)$/.test(nlc)) { w.hint = { code: 'its2', sugg: [matchCase(w.core, 'its')] }; continue }
    if (lc === 'your' && YOUR_NEXT.has(nlc)) { w.hint = { code: 'youre', sugg: [matchCase(w.core, "you're")] }; continue }
    if (lc === 'then' && prev && COMPARATIVE.has(prev.core.toLowerCase())) { w.hint = { code: 'than', sugg: [matchCase(w.core, 'than')] }; continue }
    if (lc === 'of' && prev && /^(could|should|would|must|might)$/i.test(prev.core)) { w.hint = { code: 'have', sugg: ['have'] }; continue }
    if (prev && /[.!?]$/.test(prev.post) && !ABBR.test(prev.core) && /^[a-z]/.test(w.core) && w.kind !== 'skip') {
      w.hint = { code: 'cap', sugg: [w.core[0].toUpperCase() + w.core.slice(1)] }
    }
  }
}
