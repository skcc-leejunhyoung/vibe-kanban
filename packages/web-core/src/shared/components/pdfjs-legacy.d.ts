/**
 * The legacy bundle is the only one that runs in shipping browsers: the default
 * build calls `Promise.withResolvers` and `Map.prototype.getOrInsertComputed`,
 * which not even current Node has. It carries no types of its own, so borrow
 * the package's.
 */
declare module 'pdfjs-dist/legacy/build/pdf.min.mjs' {
  export * from 'pdfjs-dist';
}
