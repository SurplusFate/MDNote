// build.mjs — esbuild 单文件出包（IIFE + minify，进 app assets）
// 用法：node build.mjs [out]
// 默认输出到 ../app/src/main/assets/editor/pm/editor-pm.dist.js
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ||
  join(here, '..', 'app', 'src', 'main', 'assets', 'editor', 'pm', 'editor-pm.dist.js');

const result = await build({
  entryPoints: [join(here, 'src', 'main.js')],
  bundle: true,
  format: 'iife',
// target es2020：Android 9+ WebView（Chromium 79 起）全覆盖，比 es2017 少一批
// 降级变换/垫层，出包更小（内核体积红线 400KB）
  target: 'es2020',
  minify: true,
  outfile: out,
  write: true,
  metafile: true,
  logLevel: 'info',
});

const files = Object.keys(result.metafile.outputs);
for (const f of files) {
  const bytes = result.metafile.outputs[f].bytes;
  console.log('OUT', f, (bytes / 1024).toFixed(1) + 'KB');
}
