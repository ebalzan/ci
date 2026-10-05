import { TYPE_CONFIG } from './config'
import type { AutoWorkItemsConfig, CoreClient, GitHubClient } from './types'
import { getErrorStatus } from './utils'

type LabelDefinition = {
  color: string
  description: string
}

const PRIORITY_COLOR_MAP: Record<string, string> = {
  p0: 'B60205',
  p1: 'D93F0B',
  p2: 'FBCA04',
  p3: '0E8A16',
  p4: '1D76DB',
}

const DEFAULT_LABEL_COLORS = [
  'B60205',
  'D93F0B',
  'FBCA04',
  '0E8A16',
  '1D76DB',
  '5319E7',
  '0052CC',
  'C5DEF5',
  'E99695',
  'F9D0C4',
  'C2E0C6',
]

function normalizeLabelColor(color: string): string {
  return color.replace('#', '').trim().toUpperCase()
}

function buildTypeDefinitions(): Record<string, LabelDefinition> {
  const definitions: Record<string, LabelDefinition> = {}

  for (const type of Object.values(TYPE_CONFIG)) {
    if (!definitions[type.label]) {
      definitions[type.label] = {
        color: normalizeLabelColor(type.color),
        description: `Changes for '${type.prefix}' branches`,
      }
    }
  }

  return definitions
}

function hashText(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 2147483647
  }
  return Math.abs(hash)
}

function resolveDefaultLabelColor(label: string): string {
  const normalized = label.trim().toLowerCase()
  const priorityMatch = normalized.match(/^priority:\s*(p[0-4])$/) ?? normalized.match(/^(p[0-4])$/)
  if (priorityMatch) {
    return PRIORITY_COLOR_MAP[priorityMatch[1]]
  }

  return DEFAULT_LABEL_COLORS[hashText(normalized) % DEFAULT_LABEL_COLORS.length]
}

async function ensureLabel({
  github,
  core,
  owner,
  repo,
  name,
  color,
  description,
}: {
  github: GitHubClient
  core: CoreClient
  owner: string
  repo: string
  name: string
  color: string
  description: string
}): Promise<void> {
  const normalizedColor = normalizeLabelColor(color)

  try {
    const { data: existingLabel } = await github.rest.issues.getLabel({ owner, repo, name })
    const existingColor = normalizeLabelColor(existingLabel.color)
    const existingDescription = (existingLabel.description || '').trim()

    if (existingColor !== normalizedColor || existingDescription !== description) {
      await github.rest.issues.updateLabel({
        owner,
        repo,
        name,
        color: normalizedColor,
        description,
      })
      core.info(`Updated label '${name}'`)
    }
  } catch (error: unknown) {
    if (getErrorStatus(error) === 404) {
      try {
        await github.rest.issues.createLabel({
          owner,
          repo,
          name,
          color: normalizedColor,
          description,
        })
        core.info(`Created label '${name}'`)
      } catch (createError: unknown) {
        // Another concurrent run may create the label first.
        if (getErrorStatus(createError) !== 422) {
          throw createError
        }
      }
      return
    }
    throw error
  }
}

export async function ensureLabels({
  github,
  core,
  config,
  labels,
}: {
  github: GitHubClient
  core: CoreClient
  config: AutoWorkItemsConfig
  labels: string[]
}): Promise<void> {
  const definitions: Record<string, LabelDefinition> = {
    ...buildTypeDefinitions(),
    [config.typeLabel]: {
      color: config.selectedType.color,
      description: `Changes for '${config.branchType}' branches`,
    },
  }

  for (const label of labels) {
    const definition = definitions[label] || {
      color: resolveDefaultLabelColor(label),
      description: 'Managed label',
    }

    await ensureLabel({
      github,
      core,
      owner: config.owner,
      repo: config.repo,
      name: label,
      color: definition.color,
      description: definition.description,
    })
  }
}
