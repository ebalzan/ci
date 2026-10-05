import type { BuildConfigResult, CoreClient, SelectedTypeConfig, WorkflowContext } from './types'
import { parseCsv, parseJsonMap, normalizeScope } from './utils'

// The only accepted branch prefixes (`<type>/<desc>`). Keep in sync with
// branchReleaseTypes in scripts/release/release-utils.mjs. Each prefix is also
// the commit/title type: this repo uses `refact`, never `refactor`.
export const TYPE_CONFIG: Record<string, SelectedTypeConfig> = {
  feat: { prefix: 'feat', label: 'feat', priority: 'P2', color: '1D76DB' },
  fix: { prefix: 'fix', label: 'fix', priority: 'P1', color: 'D73A4A' },
  docs: { prefix: 'docs', label: 'docs', priority: 'P3', color: '5319E7' },
  style: { prefix: 'style', label: 'style', priority: 'P4', color: 'C2E0C6' },
  refact: { prefix: 'refact', label: 'refact', priority: 'P2', color: 'FBCA04' },
  perf: { prefix: 'perf', label: 'perf', priority: 'P1', color: 'F9D0C4' },
  test: { prefix: 'test', label: 'test', priority: 'P3', color: '0E8A16' },
  build: { prefix: 'build', label: 'build', priority: 'P3', color: '0052CC' },
  ci: { prefix: 'ci', label: 'ci', priority: 'P3', color: '0052CC' },
  chore: { prefix: 'chore', label: 'chore', priority: 'P4', color: 'BFD4F2' },
  revert: { prefix: 'revert', label: 'revert', priority: 'P1', color: 'E99695' },
}

function buildReservedTypeLabels(): Set<string> {
  return new Set(
    Object.values(TYPE_CONFIG)
      .map(type => type.label.trim().toLowerCase())
      .filter(Boolean),
  )
}

function filterAdditionalLabels({
  labels,
  selectedTypeLabel,
  core,
  envVarName,
}: {
  labels: string[]
  selectedTypeLabel: string
  core: CoreClient
  envVarName: string
}): string[] {
  const reservedTypeLabels = buildReservedTypeLabels()
  const selected = selectedTypeLabel.trim().toLowerCase()
  const excluded = new Set<string>()
  const filtered: string[] = []

  for (const label of labels) {
    const normalized = label.trim().toLowerCase()
    if (!normalized) continue

    if (reservedTypeLabels.has(normalized) && normalized !== selected) {
      excluded.add(label)
      continue
    }

    filtered.push(label)
  }

  if (excluded.size > 0) {
    core.info(
      `${envVarName} contains reserved type labels (${Array.from(excluded).join(', ')}). ` +
        `Only '${selectedTypeLabel}' is applied automatically from branch type.`,
    )
  }

  return filtered
}

export function buildConfig({
  context,
  core,
  env,
}: {
  context: WorkflowContext
  core: CoreClient
  env: NodeJS.ProcessEnv
}): BuildConfigResult {
  const owner = context.repo.owner
  const repo = context.repo.repo
  const branch = context.ref.replace('refs/heads/', '')
  const base = env.AUTO_BASE_BRANCH || 'main'

  if (!branch || branch === base) {
    core.info(`Skipping branch '${branch}'`)
    return { skip: true }
  }

  const branchParts = branch.split('/').filter(Boolean)
  const branchType = (branchParts[0] || 'chore').toLowerCase()
  const branchScope = branchParts.slice(1).join('/') || branch
  const normalizedScope = normalizeScope(branchScope)

  const marker = `auto-work-item:${branch}`
  const selectedType = TYPE_CONFIG[branchType]
  if (!selectedType) {
    throw new Error(
      `Branch '${branch}' has unsupported type '${branchType}'. ` +
        `Rename it to <type>/<description> with type one of: ${Object.keys(TYPE_CONFIG).join(', ')}.`,
    )
  }

  const typeLabel = selectedType.label

  const priorityMap = parseJsonMap(
    env.AUTO_PRIORITY_MAP_JSON,
    core.warning,
    'AUTO_PRIORITY_MAP_JSON',
  )
  const priorityValue =
    priorityMap[branchType] || env.AUTO_DEFAULT_PRIORITY || selectedType.priority

  const issueTitle = `${selectedType.prefix}: ${normalizedScope || branch}`
  const issueBody = [
    `Tracking issue for branch \`${branch}\`.`,
    '',
    '## Context',
    `- Branch type: \`${branchType}\``,
    `- Base branch: \`${base}\``,
    '',
    '## Checklist',
    '- [ ] Define scope',
    '- [ ] Implement changes',
    '- [ ] Validate and update docs',
    '',
    `Marker: ${marker}`,
  ].join('\n')

  const prTitle = `${selectedType.prefix}: ${normalizedScope || branch}`

  const issueExtraLabels = filterAdditionalLabels({
    labels: parseCsv(env.AUTO_ISSUE_LABELS),
    selectedTypeLabel: typeLabel,
    core,
    envVarName: 'AUTO_ISSUE_LABELS',
  })

  const prExtraLabels = filterAdditionalLabels({
    labels: parseCsv(env.AUTO_PR_LABELS),
    selectedTypeLabel: typeLabel,
    core,
    envVarName: 'AUTO_PR_LABELS',
  })

  const issueLabels = Array.from(new Set([typeLabel, ...issueExtraLabels]))
  const prLabels = Array.from(new Set([typeLabel, ...prExtraLabels]))

  const sizeMap = parseJsonMap(env.AUTO_SIZE_MAP_JSON, core.warning, 'AUTO_SIZE_MAP_JSON')
  const estimateMap = parseJsonMap(
    env.AUTO_ESTIMATE_MAP_JSON,
    core.warning,
    'AUTO_ESTIMATE_MAP_JSON',
  )
  const sizeValue = (sizeMap[branchType] || env.AUTO_DEFAULT_SIZE || 'M').trim()
  const estimateValue = (estimateMap[branchType] || env.AUTO_DEFAULT_ESTIMATE || '1').trim()

  const strictMetadata = (env.AUTO_STRICT_METADATA || 'true').trim().toLowerCase() !== 'false'

  return {
    skip: false,
    owner,
    repo,
    branch,
    base,
    branchType,
    marker,
    selectedType,
    typeLabel,
    priorityValue,
    issueTitle,
    issueBody,
    prTitle,
    issueLabels,
    prLabels,
    strictMetadata,
    sizeValue,
    estimateValue,
    env,
  }
}
