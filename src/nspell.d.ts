declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean
    suggest(word: string): string[]
    add(word: string): NSpell
    personal(dic: string): NSpell
  }
  export default function nspell(aff: string, dic?: string): NSpell
}
