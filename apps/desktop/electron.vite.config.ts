import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, resolve } from 'node:path'
import solid from 'vite-plugin-solid'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * Bundle the built pettyd binary beside Electron's main output so production
 * builds do not depend on a source-tree-relative Zig artifact.
 */
function copyPettydBinary() {
  let outDir = ''

  return {
    name: 'copy-pettyd-binary',
    configResolved(config: any) {
      outDir = config.build.outDir
    },
    closeBundle() {
      if (process.env.PETTYD_SKIP_NATIVE === '1') {
        console.warn('[copy-pettyd-binary] Skipping pettyd copy; PETTYD_SKIP_NATIVE=1')
        return
      }

      if (process.platform === 'win32') {
        console.warn('[copy-pettyd-binary] Skipping pettyd copy on Windows; pettyd is POSIX-only')
        return
      }

      const exeName = 'pettyd'
      const pettydSource = resolve(__dirname, '../daemon/zig-out/bin', exeName)
      const pettydDestDir = resolve(outDir, '../bin')
      const pettydDest = resolve(pettydDestDir, exeName)

      if (!existsSync(pettydSource)) {
        throw new Error(`[copy-pettyd-binary] pettyd source not found: ${pettydSource}`)
      }

      mkdirSync(pettydDestDir, { recursive: true })
      copyFileSync(pettydSource, pettydDest)
      chmodSync(pettydDest, 0o755)
      console.log('[copy-pettyd-binary] Copied pettyd to', pettydDest)
    },
  }
}

function exposeNightlyAssets() {
  let outDir = ''
  const nightlyAssetsSource = resolve(__dirname, '../../assets/nightly')

  return {
    name: 'expose-nightly-assets',
    configResolved(config: any) {
      outDir = config.build.outDir
    },
    configureServer(server: any) {
      server.middlewares.use(
        '/nightly',
        (request: any, response: any, next: (error?: unknown) => void) => {
          let requestPath = ''
          try {
            requestPath = decodeURIComponent(String(request.url ?? '').split('?')[0] ?? '')
              .replace(/^\/+/u, '')
              .trim()
          } catch {
            next()
            return
          }
          if (!requestPath || requestPath.includes('/') || requestPath.includes('\\')) {
            next()
            return
          }

          const assetPath = resolve(nightlyAssetsSource, requestPath)
          if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
            next()
            return
          }

          if (requestPath.endsWith('.png')) response.setHeader('Content-Type', 'image/png')
          const stream = createReadStream(assetPath)
          stream.on('error', (error) => {
            if (response.headersSent) {
              response.destroy(error)
              return
            }
            next(error)
          })
          stream.pipe(response)
        },
      )
    },
    closeBundle() {
      if (!existsSync(nightlyAssetsSource)) {
        throw new Error(`[expose-nightly-assets] nightly assets not found: ${nightlyAssetsSource}`)
      }

      const nightlyAssetsDest = resolve(outDir, 'nightly')
      rmSync(nightlyAssetsDest, { recursive: true, force: true })
      copyDirectory(nightlyAssetsSource, nightlyAssetsDest)
      console.log('[expose-nightly-assets] Copied nightly assets to', nightlyAssetsDest)
    },
  }
}

function copyDirectory(source: string, destination: string) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source)) {
    const sourcePath = resolve(source, entry)
    const destinationPath = resolve(destination, basename(entry))
    const stats = statSync(sourcePath)
    if (stats.isDirectory()) {
      copyDirectory(sourcePath, destinationPath)
      continue
    }
    if (!stats.isFile()) continue
    copyFileSync(sourcePath, destinationPath)
    if (process.platform !== 'win32') chmodSync(destinationPath, stats.mode)
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyPettydBinary()],
    build: {
      sourcemap: false,
      // node-pty has been removed — pettyd owns PTY lifecycle
    },
  },
  preload: {
    // Sandbox preloads cannot require arbitrary npm modules; bundle validation schemas.
    plugins: [],
    ssr: { noExternal: ['effect', '@petty/shared'] },
    build: {
      sourcemap: false,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    plugins: [solid(), exposeNightlyAssets()],
    publicDir: resolve(__dirname, 'public'),
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
})
