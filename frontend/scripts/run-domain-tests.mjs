// 域测试入口：用 esbuild 的 JS API 打包（bin 壳在跨平台装的 node_modules 里可能是别平台的二进制），
// 再用当前 node 跑打包产物。
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

buildSync({
  entryPoints: ['tests/baggage.domain.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-test/baggage.domain.test.mjs',
})

execFileSync(process.execPath, ['dist-test/baggage.domain.test.mjs'], { stdio: 'inherit' })
