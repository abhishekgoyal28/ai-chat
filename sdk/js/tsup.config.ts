import { defineConfig } from 'tsup';

export default defineConfig([
  // npm package: ESM + CommonJS with type declarations.
  { entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, target: 'es2020' },
  // A single <script> file for pages without a bundler: window.AiChat.ChatClient
  {
    entry: { 'ai-chat': 'src/index.ts' },
    format: ['iife'],
    platform: 'browser',
    globalName: 'AiChat',
    minify: true,
    sourcemap: true,
    target: 'es2020',
    noExternal: ['socket.io-client'],
  },
]);
