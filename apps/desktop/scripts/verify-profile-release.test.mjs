import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { verifyBuiltPackageExports, verifyDefaultComposition, verifyDefaultProfile, verifyInstalledDshVersions, verifyPackageDshReferences, verifyProfileRelease, verifyReleaseArchives } from './verify-profile-release.mjs'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DSH_VERSION } from './runtime-version.mjs'
import { ENTERPRISE_PACKAGES, PRODUCT_PACKAGES, RELEASE_PACKAGES } from './workdsh-package-boundary.mjs'

test('accepts a WorkDSH release aligned with the pinned DSH runtime', () => {
  assert.doesNotThrow(() => verifyProfileRelease({
    harness: DSH_VERSION,
    runtimeOverrides: { '@deepseek-ai/dsh': DSH_VERSION, 'other-package': '1.0.0' },
  }, DSH_VERSION))
})

test('rejects an older WorkDSH release instead of relabeling its compatibility', () => {
  assert.throws(() => verifyProfileRelease({ harness: 'obsolete-dsh-version' }, DSH_VERSION), /targets DSH/)
  assert.throws(() => verifyProfileRelease({
    harness: DSH_VERSION,
    runtimeOverrides: { '@deepseek-ai/dsh-agent': 'obsolete-dsh-version' },
  }, DSH_VERSION), /overrides @deepseek-ai\/dsh-agent/)
})

test('rejects a WorkDSH package built against another DSH version', () => {
  assert.doesNotThrow(() => verifyPackageDshReferences({
    name: 'workdsh-plugin-experts',
    peerDependencies: { '@deepseek-ai/dsh-agent': DSH_VERSION },
  }, DSH_VERSION))
  assert.throws(() => verifyPackageDshReferences({
    name: 'workdsh-plugin-experts',
    peerDependencies: { '@deepseek-ai/dsh-agent': '0.1.6-alpha.1' },
  }, DSH_VERSION), /workdsh-plugin-experts references @deepseek-ai\/dsh-agent/)
})

test('requires release package changes to be reviewed before Desktop bundles them', () => {
  assert.doesNotThrow(() => verifyProfileRelease({
    harness: DSH_VERSION,
    packages: [{ name: 'workdsh-plugin-experts' }],
  }, DSH_VERSION, ['workdsh-plugin-experts']))
  assert.throws(() => verifyProfileRelease({
    harness: DSH_VERSION,
    packages: [{ name: 'workdsh-plugin-experts' }, { name: 'new-plugin' }],
  }, DSH_VERSION, ['workdsh-plugin-experts']), /package set changed/)
})

function defaultProfile() {
  return {
    dependencies: Object.fromEntries(PRODUCT_PACKAGES.map(name => [name, 'file:../cache.tgz'])),
    optionalDependencies: Object.fromEntries(RELEASE_PACKAGES.filter(name => !PRODUCT_PACKAGES.includes(name)).map(name => [name, 'file:../cache.tgz'])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...PRODUCT_PACKAGES] } },
  }
}

test('Desktop ships six default features, reviewed infrastructure and no preinstalled enterprise package', () => {
  assert.equal(PRODUCT_PACKAGES.length, 6)
  assert.deepEqual(ENTERPRISE_PACKAGES, ['workdsh-provider-identity-enterprise', 'workdsh-plugin-enterprise-collaboration', 'workdsh-enterprise-connection'])
  assert.equal(RELEASE_PACKAGES.length, 13)
  assert.doesNotThrow(() => verifyDefaultProfile(defaultProfile()))
  for (const name of ['workdsh-plugin-office', 'workdsh-plugin-notifications']) {
    const profile = defaultProfile()
    profile.optionalDependencies[name] = 'file:../external.tgz'
    assert.throws(() => verifyDefaultProfile(profile), /owned dependency closure changed/)
  }
})

test('enterprise delivery cannot activate or expose enterprise identity in the default personal composition', () => {
  const selected = defaultProfile()
  selected.dsh.profile.bundles.push(ENTERPRISE_PACKAGES[0])
  assert.throws(() => verifyDefaultProfile(selected), /selected features changed/)
  const exposed = defaultProfile()
  exposed.dependencies[ENTERPRISE_PACKAGES[0]] = exposed.optionalDependencies[ENTERPRISE_PACKAGES[0]]
  delete exposed.optionalDependencies[ENTERPRISE_PACKAGES[0]]
  assert.throws(() => verifyDefaultProfile(exposed), /direct features changed/)
  assert.doesNotThrow(() => verifyDefaultComposition('- id: workdsh-identity-local\n  name: workdsh-provider-identity-local\n'))
  assert.throws(() => verifyDefaultComposition('- insert:\n    - id: workdsh-identity-enterprise\n      name: workdsh-provider-identity-enterprise\n'), /active in the default personal composition/)
  assert.throws(() => verifyDefaultComposition('- name: workdsh-provider-identity-enterprise/desktop\n'), /active in the default personal composition/)
})

test('default Profile rejects a missing or duplicate feature and exposed infrastructure', () => {
  const missing = defaultProfile()
  missing.dsh.profile.bundles.pop()
  assert.throws(() => verifyDefaultProfile(missing), /selected features changed/)
  const duplicate = defaultProfile()
  duplicate.dsh.profile.bundles.push(PRODUCT_PACKAGES[0])
  assert.throws(() => verifyDefaultProfile(duplicate), /selected features changed/)
  const infrastructure = defaultProfile()
  infrastructure.dependencies['workdsh-plugin-access'] = infrastructure.optionalDependencies['workdsh-plugin-access']
  delete infrastructure.optionalDependencies['workdsh-plugin-access']
  assert.throws(() => verifyDefaultProfile(infrastructure), /direct features changed/)
})

test('release archives reject changed bytes and unsafe metadata before installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workdsh-release-check-'))
  try {
    const bytes = Buffer.from('owned archive fixture')
    const item = { name: 'workdsh-plugin-experts', filename: 'experts.tgz', sha256: createHash('sha256').update(bytes).digest('hex') }
    writeFileSync(join(directory, item.filename), bytes)
    assert.doesNotThrow(() => verifyReleaseArchives({ packages: [item] }, directory))
    writeFileSync(join(directory, item.filename), 'changed archive')
    assert.throws(() => verifyReleaseArchives({ packages: [item] }, directory), /digest mismatch/)
    assert.throws(() => verifyReleaseArchives({ packages: [{ ...item, filename: '../experts.tgz' }] }, directory), /Invalid owned archive metadata/)
    assert.throws(() => verifyReleaseArchives({ packages: [{ ...item, sha256: '' }] }, directory), /Invalid owned archive metadata/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('installed version gate rejects an older transitive runtime behind an aligned root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workdsh-installed-version-'))
  try {
    const root = join(directory, 'node_modules/@deepseek-ai/dsh')
    const nested = join(directory, 'node_modules/.pnpm/old-runtime/node_modules/@deepseek-ai/dsh-agent')
    mkdirSync(root, { recursive: true }); mkdirSync(nested, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION }))
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent', version: DSH_VERSION }))
    assert.equal(verifyInstalledDshVersions(directory, DSH_VERSION), 2)
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent', version: '0.1.7' }))
    assert.throws(() => verifyInstalledDshVersions(directory, DSH_VERSION), /dsh-agent is 0\.1\.7/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('validates conditional exports and locale patterns without accepting missing artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'export-map-'))
  try {
    mkdirSync(join(directory, 'dist')); mkdirSync(join(directory, 'locale'))
    writeFileSync(join(directory, 'dist/index.js'), '')
    writeFileSync(join(directory, 'dist/index.d.ts'), '')
    writeFileSync(join(directory, 'locale/en.json'), '{}')
    const pkg = { name: 'fixture', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './locale/*.json': './locale/*.json' } }
    assert.doesNotThrow(() => verifyBuiltPackageExports(pkg, directory))
    rmSync(join(directory, 'dist/index.js'))
    assert.throws(() => verifyBuiltPackageExports(pkg, directory), /Missing built export.*index.js/)
    writeFileSync(join(directory, 'dist/index.js'), '')
    rmSync(join(directory, 'locale/en.json'))
    assert.throws(() => verifyBuiltPackageExports(pkg, directory), /Missing built export.*locale/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('cross-architecture macOS runtime installs target native dependencies as well as host', async () => {
 const {runtimeArchitecture,runtimeArchitectureYaml}=await import('./runtime-architecture.mjs');
 const target=runtimeArchitecture({WORKDSH_MAC_ARCH:'x64'},'darwin','arm64');
 assert.deepEqual(target.cpus,['arm64','x64']);
 assert.equal(target.targetArch,'x64');
 assert.match(runtimeArchitectureYaml(target),/cpu:\n    - arm64\n    - x64/);
 assert.deepEqual(runtimeArchitecture({},'win32','x64').cpus,['x64']);
 assert.throws(()=>runtimeArchitecture({WORKDSH_MAC_ARCH:'invalid'},'darwin','arm64'),/Unsupported/);
});
