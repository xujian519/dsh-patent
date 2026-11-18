import { defineConfig } from 'tsdown'

/**
 * legal-knowledge ships TWO runtime entries: the service plugin (index) and the
 * legal-knowledge-install CLI (bin). Each is built as a self-contained file with
 * code splitting disabled, so the shared install/config modules are inlined into
 * both entries instead of emitting a hashed chunk the published files list would
 * miss. Declarations come from tsc -b (dts: false).
 */
export default defineConfig([
  { entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false },
  { entry: ['lib/types/bin.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false },
])
