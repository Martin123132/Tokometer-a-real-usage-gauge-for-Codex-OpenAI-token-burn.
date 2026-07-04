import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const checksumIndexFile = 'SHA256SUMS.txt'
export const releaseManifestFile = 'release-manifest.json'
export const releaseManifestSchema = 'tokometer-release-manifest-v1'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultPackageJson = JSON.parse(
  await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
)
const defaultReleaseDir = path.join(repoRoot, 'release')
const excludedReleaseFiles = new Set([
  checksumIndexFile,
  releaseManifestFile,
  'builder-debug.yml',
])

function parseArgs(argv) {
  const options = {
    writeChecksums: false,
    releaseDir: defaultReleaseDir,
  }

  for (const arg of argv) {
    if (arg === '--write') {
      options.writeChecksums = true
      continue
    }
    if (arg.startsWith('--release-dir=')) {
      options.releaseDir = path.resolve(arg.slice('--release-dir='.length))
    }
  }

  return options
}

export function requiredArtifactsFor(packageJson = defaultPackageJson) {
  const productName = packageJson.build?.productName ?? packageJson.name
  const version = packageJson.version

  return [
    `${productName} Setup ${version}.exe`,
    `${productName} ${version}.exe`,
  ]
}

export function formatBytes(value) {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${value} B`
}

export async function sha256(filePath) {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex').toUpperCase()
}

function resolveCommitSha() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA
  }
  if (process.env.TOKOMETER_BUILD_SHA) {
    return process.env.TOKOMETER_BUILD_SHA
  }

  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const dirty = execSync('git status --porcelain --untracked-files=no', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return null
  }
}

async function assertRequiredArtifacts(releaseDir, requiredArtifacts) {
  const missing = []

  for (const artifact of requiredArtifacts) {
    const artifactPath = path.join(releaseDir, artifact)
    try {
      const artifactStat = await stat(artifactPath)
      if (artifactStat.size < 1024 * 1024) {
        throw new Error(
          `${artifact} is unexpectedly small (${formatBytes(artifactStat.size)})`,
        )
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('unexpectedly small')) {
        throw error
      }
      missing.push(artifact)
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing release artifacts: ${missing.join(', ')}`)
  }
}

async function listReleaseFiles(releaseDir) {
  return (await readdir(releaseDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith('.sha256'))
    .filter((name) => !excludedReleaseFiles.has(name))
    .sort((a, b) => a.localeCompare(b))
}

async function removeStaleExcludedChecksums(releaseDir) {
  await Promise.all(
    [...excludedReleaseFiles].map((file) =>
      rm(path.join(releaseDir, `${file}.sha256`), { force: true }),
    ),
  )
}

export async function verifyRelease({
  releaseDir = defaultReleaseDir,
  packageJson = defaultPackageJson,
  writeChecksums = false,
  generatedAt = new Date().toISOString(),
  commitSha = resolveCommitSha(),
} = {}) {
  const productName = packageJson.build?.productName ?? packageJson.name
  const version = packageJson.version
  const requiredArtifacts = requiredArtifactsFor(packageJson)

  await assertRequiredArtifacts(releaseDir, requiredArtifacts)

  const files = await listReleaseFiles(releaseDir)
  if (files.length === 0) {
    throw new Error('No release files found.')
  }

  const artifacts = []

  for (const file of files) {
    const filePath = path.join(releaseDir, file)
    const fileStat = await stat(filePath)
    artifacts.push({
      file,
      sizeBytes: fileStat.size,
      sha256: await sha256(filePath),
    })
  }

  const checksumLines = artifacts.map(
    (artifact) => `${artifact.sha256}  ${artifact.file}`,
  )
  const manifest = {
    schema: releaseManifestSchema,
    productName,
    version,
    generatedAt,
    commitSha,
    license:
      'PolyForm Noncommercial License 1.0.0; commercial use requires a separate written license from TWO HANDS NETWORK LTD.',
    requiredArtifacts,
    artifacts,
    verifier: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  }

  if (writeChecksums) {
    await removeStaleExcludedChecksums(releaseDir)

    for (const artifact of artifacts) {
      await writeFile(
        path.join(releaseDir, `${artifact.file}.sha256`),
        `${artifact.sha256}  ${artifact.file}\n`,
        'utf8',
      )
    }

    await writeFile(
      path.join(releaseDir, checksumIndexFile),
      `${checksumLines.join('\n')}\n`,
      'utf8',
    )
    await writeFile(
      path.join(releaseDir, releaseManifestFile),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
  }

  return {
    requiredArtifacts,
    artifacts,
    checksumLines,
    manifest,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = await verifyRelease(options)

  console.log(`Verified ${result.requiredArtifacts.length} required artifacts.`)

  for (const artifact of result.artifacts) {
    console.log(
      `${artifact.sha256}  ${artifact.file} (${formatBytes(artifact.sizeBytes)})`,
    )
  }

  if (options.writeChecksums) {
    console.log(`Wrote ${checksumIndexFile}, ${releaseManifestFile}, and per-file SHA256 checksums.`)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null

if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
