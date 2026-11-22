import { defineConfig } from 'tsdown'

/** Build the benchmark-driven self-evolve provider and its operator driver. */
export default defineConfig([
  // `codeSplitting: false` is what keeps each subpath self-contained, and it
  // rejects multiple inputs, so each entry gets its own bundle.
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/baseline-driver.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
  },
])
