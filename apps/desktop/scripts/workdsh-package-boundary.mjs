// Review this inventory when the WorkDSH release adds or removes a package.
// Only product packages are selected or exposed by the default personal Profile.
export const PRODUCT_PACKAGES = Object.freeze([
  'workdsh-plugin-connectors',
  'workdsh-plugin-experts',
  'workdsh-plugin-library',
  'workdsh-plugin-projects',
  'workdsh-plugin-scene-card',
  'workdsh-plugin-skills',
])

// External enterprise packages: installed explicitly, never included in the base installer.
export const ENTERPRISE_PACKAGES = Object.freeze([
  'workdsh-provider-identity-enterprise',
  'workdsh-plugin-enterprise-collaboration',
  'workdsh-enterprise-connection',
])

// Keep the already shipped community catalog integrations on the same Profile.
export const CATALOG_PACKAGES = Object.freeze({
  '@cocofhu/skillhub': '0.2.16',
  dshmarket: '1.66.8',
})

export const RELEASE_PACKAGES = Object.freeze([
  'workdsh-contracts',
  'workdsh-ui',
  'workdsh-provider-identity-local',
  'workdsh-provider-browser-session',
  'workdsh-plugin-audit',
  'workdsh-plugin-access',
  'workdsh-plugin-skills',
  'workdsh-plugin-experts',
  'workdsh-plugin-connectors',
  'workdsh-plugin-library',
  'workdsh-plugin-scene-card',
  'workdsh-bundle',
  'workdsh-plugin-projects',
])

export const PACKAGE_DIRECTORIES = Object.freeze({
  'workdsh-contracts': '../../packages/contracts',
  'workdsh-ui': '../../packages/ui',
  'workdsh-provider-identity-local': '../../packages/providers/identity-local',
  'workdsh-provider-browser-session': '../../packages/providers/browser-session',
  'workdsh-plugin-audit': '../../packages/plugins/audit',
  'workdsh-plugin-access': '../../packages/plugins/access',
  'workdsh-plugin-skills': '../../packages/plugins/skills',
  'workdsh-plugin-experts': '../../packages/plugins/experts',
  'workdsh-plugin-connectors': '../../packages/plugins/connectors',
  'workdsh-plugin-library': '../../packages/plugins/library',
  'workdsh-plugin-scene-card': '../../packages/plugins/scene-card',
  'workdsh-bundle': '../../packages/bundle',
  'workdsh-plugin-projects': '../../packages/plugins/projects',
  'workdsh-provider-identity-enterprise': '../../packages/providers/identity-enterprise',
  'workdsh-plugin-enterprise-collaboration': '../../packages/plugins/enterprise-collaboration',
})
