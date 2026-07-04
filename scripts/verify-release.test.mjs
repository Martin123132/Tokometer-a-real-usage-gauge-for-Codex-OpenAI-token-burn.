import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checksumIndexFile,
  releaseManifestFile,
  releaseManifestSchema,
  requiredArtifactsFor,
  verifyRelease,
} from './verify-release.mjs'

const tempRoots = []
const fixturePackage = {
  name: 'tokometer',
  version: '1.2.3',
  build: {
    productName: 'Tokometer',
  },
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.length = 0
})

describe('release verifier', () => {
  it('writes aggregate checksums and a release manifest', async () => {
    const releaseDir = await createReleaseFixture()

    const result = await verifyRelease({
      releaseDir,
      packageJson: fixturePackage,
      writeChecksums: true,
      generatedAt: '2026-07-04T10:00:00.000Z',
      commitSha: 'abc123def456',
    })

    expect(result.requiredArtifacts).toEqual(requiredArtifactsFor(fixturePackage))
    expect(result.artifacts).toHaveLength(2)
    expect(result.artifacts.some((artifact) => artifact.file === 'builder-debug.yml')).toBe(false)
    expect(result.manifest.schema).toBe(releaseManifestSchema)
    expect(result.manifest.commitSha).toBe('abc123def456')

    const checksumIndex = await readFile(path.join(releaseDir, checksumIndexFile), 'utf8')
    expect(checksumIndex).toContain('Tokometer 1.2.3.exe')
    expect(checksumIndex).toContain('Tokometer Setup 1.2.3.exe')
    expect(checksumIndex).not.toContain('builder-debug.yml')

    const manifest = JSON.parse(
      await readFile(path.join(releaseDir, releaseManifestFile), 'utf8'),
    )
    expect(manifest.artifacts.map((artifact) => artifact.file)).toEqual(
      result.artifacts.map((artifact) => artifact.file),
    )
    expect(manifest.license).toContain('commercial use requires')

    for (const artifact of result.artifacts) {
      const checksum = await readFile(
        path.join(releaseDir, `${artifact.file}.sha256`),
        'utf8',
      )
      expect(checksum).toBe(`${artifact.sha256}  ${artifact.file}\n`)
    }

    await expect(
      readFile(path.join(releaseDir, 'builder-debug.yml.sha256'), 'utf8'),
    ).rejects.toThrow()
  })

  it('rejects missing required artifacts', async () => {
    const releaseDir = await createTempDir()
    await writeFile(path.join(releaseDir, 'Tokometer Setup 1.2.3.exe'), largeBuffer(2))

    await expect(
      verifyRelease({
        releaseDir,
        packageJson: fixturePackage,
        writeChecksums: false,
      }),
    ).rejects.toThrow('Missing release artifacts: Tokometer 1.2.3.exe')
  })
})

async function createReleaseFixture() {
  const releaseDir = await createTempDir()
  await writeFile(path.join(releaseDir, 'Tokometer Setup 1.2.3.exe'), largeBuffer(2))
  await writeFile(path.join(releaseDir, 'Tokometer 1.2.3.exe'), largeBuffer(3))
  await writeFile(path.join(releaseDir, 'builder-debug.yml'), 'localPath: C:\\Users\\you\n')
  await writeFile(path.join(releaseDir, 'builder-debug.yml.sha256'), 'stale\n')
  return releaseDir
}

async function createTempDir() {
  const base =
    process.env.TOKOMETER_TEMP_DIR ??
    (process.platform === 'win32' ? 'D:\\Temp' : os.tmpdir())
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(path.join(base, 'tokometer-release-test-'))
  tempRoots.push(root)
  return root
}

function largeBuffer(megabytes) {
  return Buffer.alloc(megabytes * 1024 * 1024, 1)
}
