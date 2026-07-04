import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { getUsageSummaryWithBackgroundScan } from './server/usage'

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version?: string }

function resolveGitSha() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA
  }
  if (process.env.TOKOMETER_BUILD_SHA) {
    return process.env.TOKOMETER_BUILD_SHA
  }

  try {
    const sha = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const dirty = execSync('git status --porcelain --untracked-files=no', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

const releaseMetadata = {
  version: packageJson.version ?? '0.0.0',
  channel: process.env.TOKOMETER_RELEASE_CHANNEL ?? 'local-first',
  buildSha: resolveGitSha(),
  buildDate: process.env.TOKOMETER_BUILD_DATE ?? new Date().toISOString(),
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __TOKOMETER_VERSION__: JSON.stringify(releaseMetadata.version),
    __TOKOMETER_RELEASE_CHANNEL__: JSON.stringify(releaseMetadata.channel),
    __TOKOMETER_BUILD_SHA__: JSON.stringify(releaseMetadata.buildSha),
    __TOKOMETER_BUILD_DATE__: JSON.stringify(releaseMetadata.buildDate),
  },
  plugins: [
    react(),
    {
      name: 'codex-token-usage-api',
      configureServer(server) {
        server.middlewares.use('/api/health', (_request, response) => {
          response.statusCode = 200
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ ok: true }))
        })

        server.middlewares.use('/api/usage', async (request, response) => {
          const anomalyPolicy = request.url
            ? new URL(request.url, 'http://localhost').searchParams.get('anomalyPolicy') ??
              undefined
            : undefined
          try {
            const payload = await getUsageSummaryWithBackgroundScan({
              anomalyPolicy,
            })
            response.statusCode = 200
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(payload))
          } catch (error) {
            response.statusCode = 500
            response.setHeader('Content-Type', 'application/json')
            response.end(
              JSON.stringify({
                error:
                  error instanceof Error ? error.message : 'Unknown error',
              }),
            )
          }
        })
      },
    },
  ],
})
