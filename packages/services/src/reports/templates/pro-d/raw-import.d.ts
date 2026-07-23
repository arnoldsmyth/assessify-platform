/**
 * Ambient module for Vite/Vitest's `?raw` import suffix (loads a file's
 * contents as a plain string at build/test time). Used by
 * `report-template.test.ts` to load `report.html` and the committed golden
 * file without reaching for Node's `fs` — this package deliberately compiles
 * against `lib: ["ES2022"]` only, no `@types/node` (see the UTF-8 helpers at
 * the bottom of `../../report-service.ts`), so there is no ambient `fs`
 * typing to import here either.
 */
declare module '*.html?raw' {
  const content: string;
  export default content;
}
