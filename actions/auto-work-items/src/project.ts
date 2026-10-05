import type {
  AutoWorkItemsConfig,
  CoreClient,
  GitHubClient,
  GitHubIssue,
  GitHubPullRequest,
} from './types'
import { addDays, asDateOffset, getErrorMessage, toISODate } from './utils'

type ProjectFieldOption = {
  id: string
  name: string
}

type ProjectField = {
  id: string
  name: string
  options?: ProjectFieldOption[] | null
}

type ProjectV2 = {
  id: string
  title: string
  fields?: {
    nodes?: (ProjectField | null)[] | null
  } | null
}

type ProjectV2DetailsQueryResult = {
  repositoryOwner?: {
    __typename?: string
    projectV2?: ProjectV2 | null
  } | null
}

type ProjectV2Details = {
  project: ProjectV2 | null
  // Issue fields are an organization-only feature; a user-owned board has none.
  ownerIsOrganization: boolean
}

type ProjectItem = {
  id: string
  content?: {
    id: string
  } | null
}

type FindProjectItemIdQueryResult = {
  node?: {
    items?: {
      nodes?: (ProjectItem | null)[] | null
      pageInfo?: {
        hasNextPage: boolean
        endCursor: string | null
      } | null
    } | null
  } | null
}

type AddProjectItemMutationResult = {
  addProjectV2ItemById?: {
    item?: {
      id: string
    } | null
  } | null
}

const PROJECT_SYNC_MAX_ATTEMPTS = 3
const PROJECT_SYNC_BASE_DELAY_MS = 1000

function isProjectField(field: ProjectField | null | undefined): field is ProjectField {
  return Boolean(field?.id && field?.name)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds)
  })
}

async function withRetry<T>({
  operation,
  maxAttempts = PROJECT_SYNC_MAX_ATTEMPTS,
}: {
  operation: () => Promise<T>
  maxAttempts?: number
}): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error: unknown) {
      lastError = error
      if (attempt === maxAttempts) break
      await wait(PROJECT_SYNC_BASE_DELAY_MS * attempt)
    }
  }

  throw lastError
}

async function getProjectV2Details({
  github,
  projectOwner,
  projectNumber,
}: {
  github: GitHubClient
  projectOwner: string
  projectNumber: number
}): Promise<ProjectV2Details> {
  const query = `
    query($login: String!, $number: Int!) {
      repositoryOwner(login: $login) {
        __typename
        ... on Organization {
          projectV2(number: $number) {
            id
            title
            fields(first: 100) {
              nodes {
                __typename
                ... on ProjectV2FieldCommon {
                  id
                  name
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
        ... on User {
          projectV2(number: $number) {
            id
            title
            fields(first: 100) {
              nodes {
                __typename
                ... on ProjectV2FieldCommon {
                  id
                  name
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `

  const result = await github.graphql<ProjectV2DetailsQueryResult>(query, {
    login: projectOwner,
    number: projectNumber,
  })

  return {
    project: result.repositoryOwner?.projectV2 || null,
    ownerIsOrganization: result.repositoryOwner?.__typename === 'Organization',
  }
}

async function findProjectItemId({
  github,
  projectId,
  contentId,
}: {
  github: GitHubClient
  projectId: string
  contentId: string
}): Promise<string | null> {
  let cursor: string | null = null

  while (true) {
    const query = `
      query($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              nodes {
                id
                content {
                  __typename
                  ... on Issue { id }
                  ... on PullRequest { id }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `

    const result: FindProjectItemIdQueryResult = await github.graphql(query, {
      projectId,
      cursor,
    })
    const items: (ProjectItem | null)[] = result.node?.items?.nodes || []

    const match = items.find((item: ProjectItem | null) => item?.content?.id === contentId)
    if (match?.id) return match.id

    const pageInfo = result.node?.items?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    cursor = pageInfo.endCursor
  }

  return null
}

async function addOrGetProjectItemId({
  github,
  projectId,
  contentId,
}: {
  github: GitHubClient
  projectId: string
  contentId: string
}): Promise<string> {
  const existingItemId = await findProjectItemId({ github, projectId, contentId })
  if (existingItemId) return existingItemId

  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `

  return withRetry({
    operation: async () => {
      try {
        const result: AddProjectItemMutationResult = await github.graphql(mutation, {
          projectId,
          contentId,
        })
        const itemId = result.addProjectV2ItemById?.item?.id
        if (!itemId) {
          throw new Error(`Could not add project item for content '${contentId}'.`)
        }
        return itemId
      } catch (error: unknown) {
        // GitHub can surface duplicate/race errors for existing project items.
        const alreadyAddedId = await findProjectItemId({ github, projectId, contentId })
        if (alreadyAddedId) return alreadyAddedId
        throw error
      }
    },
  })
}

function normalizeFieldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function findFieldByNames(fields: ProjectField[], names: string[]): ProjectField | null {
  const expected = new Set(names.map(normalizeFieldName))
  return fields.find(field => expected.has(normalizeFieldName(field.name || ''))) || null
}

function parsePriorityLevel(value: string): number | null {
  const match = value
    .trim()
    .toLowerCase()
    .match(/\bp\s*([0-9]+)\b/)
  if (!match) return null

  const level = Number(match[1])
  return Number.isInteger(level) ? level : null
}

function findNearestPriorityOption(
  options: ProjectFieldOption[],
  desiredValue: string,
): ProjectFieldOption | null {
  const desiredLevel = parsePriorityLevel(desiredValue)
  if (desiredLevel === null) return null

  const candidates = options
    .map(option => ({ option, level: parsePriorityLevel(option.name) }))
    .filter((entry): entry is { option: ProjectFieldOption; level: number } => entry.level !== null)

  if (candidates.length === 0) return null

  let best = candidates[0]
  for (const candidate of candidates.slice(1)) {
    const candidateDistance = Math.abs(candidate.level - desiredLevel)
    const bestDistance = Math.abs(best.level - desiredLevel)

    if (candidateDistance < bestDistance) {
      best = candidate
      continue
    }

    if (candidateDistance === bestDistance && candidate.level < best.level) {
      best = candidate
    }
  }

  return best.option
}

function findSingleSelectOption(
  options: ProjectFieldOption[],
  desiredValue: string,
  fieldName: string,
): ProjectFieldOption | null {
  const normalizedDesired = normalizeFieldName(desiredValue)
  if (!normalizedDesired) return null

  const exact = options.find(option => normalizeFieldName(option.name) === normalizedDesired)
  if (exact) return exact

  const rawDesired = desiredValue.trim().toLowerCase()
  const wrappedMatch = options.find(option =>
    option.name.trim().toLowerCase().includes(`(${rawDesired})`),
  )
  if (wrappedMatch) return wrappedMatch

  if (normalizedDesired.length === 1) {
    const tshirtAliases: Record<string, string[]> = {
      xxs: ['xx small', 'extra extra small'],
      xs: ['x small', 'extra small'],
      s: ['small'],
      m: ['medium'],
      l: ['large'],
      xl: ['x large', 'extra large'],
      xxl: ['xx large', 'extra extra large'],
    }
    const aliases = tshirtAliases[normalizedDesired] || []
    if (aliases.length > 0) {
      const aliasMatch = options.find(option => {
        const normalizedOption = normalizeFieldName(option.name)
        return aliases.some(alias => normalizedOption.includes(alias))
      })
      if (aliasMatch) return aliasMatch
    }
  }

  if (normalizeFieldName(fieldName) === 'priority') {
    const nearestPriority = findNearestPriorityOption(options, desiredValue)
    if (nearestPriority) return nearestPriority
  }

  if (normalizedDesired.length > 1) {
    return (
      options.find(option => normalizeFieldName(option.name).includes(normalizedDesired)) || null
    )
  }

  return null
}

type IssueFieldValueInput =
  | { dateValue: string }
  | { numberValue: number }
  | { textValue: string }
  | { singleSelectOptionId: string }

// ---------- custom project-item field setters ----------

async function setProjectDateField({
  github,
  projectId,
  itemId,
  fieldId,
  value,
}: {
  github: GitHubClient
  projectId: string
  itemId: string
  fieldId: string
  value: string
}): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Date!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { date: $value }
        }
      ) {
        projectV2Item { id }
      }
    }
  `

  await withRetry({
    operation: async () => {
      await github.graphql(mutation, { projectId, itemId, fieldId, value })
    },
  })
}

async function setProjectSingleSelectField({
  github,
  projectId,
  itemId,
  fieldId,
  optionId,
}: {
  github: GitHubClient
  projectId: string
  itemId: string
  fieldId: string
  optionId: string
}): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item { id }
      }
    }
  `

  await withRetry({
    operation: async () => {
      await github.graphql(mutation, { projectId, itemId, fieldId, optionId })
    },
  })
}

async function setProjectNumberField({
  github,
  projectId,
  itemId,
  fieldId,
  value,
}: {
  github: GitHubClient
  projectId: string
  itemId: string
  fieldId: string
  value: number
}): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { number: $value }
        }
      ) {
        projectV2Item { id }
      }
    }
  `

  await withRetry({
    operation: async () => {
      await github.graphql(mutation, { projectId, itemId, fieldId, value })
    },
  })
}

async function setProjectTextField({
  github,
  projectId,
  itemId,
  fieldId,
  value,
}: {
  github: GitHubClient
  projectId: string
  itemId: string
  fieldId: string
  value: string
}): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { text: $value }
        }
      ) {
        projectV2Item { id }
      }
    }
  `

  await withRetry({
    operation: async () => {
      await github.graphql(mutation, { projectId, itemId, fieldId, value })
    },
  })
}

async function setProjectGenericField({
  github,
  projectId,
  itemId,
  field,
  value,
}: {
  github: GitHubClient
  projectId: string
  itemId: string
  field: ProjectField
  value: string
}): Promise<void> {
  if (!value.trim()) {
    throw new Error(`Cannot set field '${field.name}' with an empty value.`)
  }

  if (field.options && field.options.length > 0) {
    const option = findSingleSelectOption(field.options, value, field.name)
    if (!option) {
      throw new Error(`Option '${value}' was not found in field '${field.name}'.`)
    }
    await setProjectSingleSelectField({
      github,
      projectId,
      itemId,
      fieldId: field.id,
      optionId: option.id,
    })
    return
  }

  const asNumber = Number(value)
  if (Number.isFinite(asNumber)) {
    await setProjectNumberField({ github, projectId, itemId, fieldId: field.id, value: asNumber })
    return
  }

  await setProjectTextField({ github, projectId, itemId, fieldId: field.id, value })
}

// ---------- org issue fields (GA 2026-07-02) ----------

type IssueField = {
  id: string
  name: string
  dataType: string
  options?: ProjectFieldOption[] | null
}

type OrgIssueFieldsQueryResult = {
  organization?: {
    issueFields?: {
      nodes?: (IssueField | null)[] | null
      pageInfo?: { hasNextPage: boolean; endCursor: string | null } | null
    } | null
  } | null
}

// The org's default Priority/Effort/Start date/Target date became issue-scoped and now
// reject updateProjectV2ItemFieldValue ("Issue field values cannot be updated ...").
// https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available/
function isIssueFieldError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return message.includes('issue field') || message.includes('updateissuefieldvalue')
}

async function getOrgIssueFields({
  github,
  org,
}: {
  github: GitHubClient
  org: string
}): Promise<IssueField[]> {
  const query = `
    query($login: String!, $cursor: String) {
      organization(login: $login) {
        issueFields(first: 100, after: $cursor) {
          nodes {
            __typename
            ... on IssueFieldCommon {
              id
              name
              dataType
            }
            ... on IssueFieldSingleSelect {
              options {
                id
                name
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `

  const collected: IssueField[] = []
  let cursor: string | null = null

  while (true) {
    const result: OrgIssueFieldsQueryResult = await github.graphql(query, { login: org, cursor })
    const connection = result.organization?.issueFields
    for (const node of connection?.nodes || []) {
      if (node?.id && node?.name && node?.dataType) collected.push(node)
    }
    const pageInfo = connection?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    cursor = pageInfo.endCursor
  }

  return collected
}

function findIssueFieldByNames(fields: IssueField[], names: string[]): IssueField | null {
  const expected = new Set(names.map(normalizeFieldName))
  return fields.find(field => expected.has(normalizeFieldName(field.name || ''))) || null
}

async function setIssueFieldValue({
  github,
  issueId,
  fieldId,
  value,
}: {
  github: GitHubClient
  issueId: string
  fieldId: string
  value: IssueFieldValueInput
}): Promise<void> {
  const mutation = `
    mutation($issueId: ID!, $field: IssueFieldCreateOrUpdateInput!) {
      updateIssueFieldValue(input: { issueId: $issueId, issueField: $field }) {
        clientMutationId
      }
    }
  `

  await withRetry({
    operation: async () => {
      await github.graphql(mutation, { issueId, field: { fieldId, ...value } })
    },
  })
}

// Sets an org issue field on the issue, choosing the value shape from the field's data
// type. Single-select options are resolved from the ISSUE field's own options (a
// project field's option ids do not match the issue field's).
async function setIssueField({
  github,
  issueId,
  field,
  value,
}: {
  github: GitHubClient
  issueId: string
  field: IssueField
  value: string
}): Promise<void> {
  if (!value.trim()) {
    throw new Error(`Cannot set issue field '${field.name}' with an empty value.`)
  }

  switch (field.dataType) {
    case 'DATE':
      await setIssueFieldValue({ github, issueId, fieldId: field.id, value: { dateValue: value } })
      return
    case 'NUMBER': {
      const asNumber = Number(value)
      if (!Number.isFinite(asNumber)) {
        throw new Error(`Issue field '${field.name}' expects a number but got '${value}'.`)
      }
      await setIssueFieldValue({
        github,
        issueId,
        fieldId: field.id,
        value: { numberValue: asNumber },
      })
      return
    }
    case 'SINGLE_SELECT': {
      const option = findSingleSelectOption(field.options || [], value, field.name)
      if (!option) {
        throw new Error(`Option '${value}' was not found in issue field '${field.name}'.`)
      }
      await setIssueFieldValue({
        github,
        issueId,
        fieldId: field.id,
        value: { singleSelectOptionId: option.id },
      })
      return
    }
    case 'TEXT':
      await setIssueFieldValue({ github, issueId, fieldId: field.id, value: { textValue: value } })
      return
    default:
      throw new Error(`Unsupported issue field type '${field.dataType}' for '${field.name}'.`)
  }
}

function getMetadataFailureHandler({
  config,
  core,
}: {
  config: AutoWorkItemsConfig
  core: CoreClient
}): (message: string) => void {
  return message => {
    if (config.strictMetadata) {
      throw new Error(message)
    }
    core.warning(message)
  }
}

export async function syncProjectMetadata({
  github,
  core,
  config,
  issue,
  pr,
}: {
  github: GitHubClient
  core: CoreClient
  config: AutoWorkItemsConfig
  issue: GitHubIssue
  pr: GitHubPullRequest
}): Promise<void> {
  const failOrWarn = getMetadataFailureHandler({ config, core })
  const projectNumber = Number(config.env.AUTO_PROJECT_NUMBER || 0)
  const projectOwner = (config.env.AUTO_PROJECT_OWNER || config.owner).trim()

  if (!projectNumber) {
    failOrWarn('AUTO_PROJECT_NUMBER not set; project assignment and field updates cannot run.')
    return
  }

  let details: ProjectV2Details
  try {
    details = await getProjectV2Details({ github, projectOwner, projectNumber })
  } catch (error: unknown) {
    failOrWarn(`Could not access project metadata: ${getErrorMessage(error)}`)
    return
  }

  const project = details.project
  if (!project) {
    failOrWarn(`Project v2 #${projectNumber} was not found for owner '${projectOwner}'.`)
    return
  }

  const fields = (project.fields?.nodes || []).filter(isProjectField)
  const projectId = project.id
  const projectTitle = project.title

  // Org issue fields (GA 2026-07-02): Priority/Effort/Start date/Target date and any
  // custom ones. Organizations only — a user-owned board has no issue fields, so we
  // skip the query entirely rather than warn on every run. Best-effort either way: if
  // it fails we fall back to project fields only.
  let issueFields: IssueField[] = []
  if (details.ownerIsOrganization) {
    try {
      issueFields = await getOrgIssueFields({ github, org: projectOwner })
    } catch (error: unknown) {
      core.warning(`Could not read organization issue fields: ${getErrorMessage(error)}`)
    }
  }

  const startOffset = asDateOffset(config.env.AUTO_START_DATE_OFFSET_DAYS, 0)
  const targetOffset = asDateOffset(config.env.AUTO_TARGET_DATE_OFFSET_DAYS, 7)

  const now = new Date()
  const startDate = toISODate(addDays(now, startOffset))
  const targetDate = toISODate(addDays(now, targetOffset))

  let issueItemId: string
  let prItemId: string

  try {
    issueItemId = await addOrGetProjectItemId({ github, projectId, contentId: issue.node_id })
    prItemId = await addOrGetProjectItemId({ github, projectId, contentId: pr.node_id })
  } catch (error: unknown) {
    failOrWarn(`Could not add issue/PR to project '${projectTitle}': ${getErrorMessage(error)}`)
    return
  }

  // Sets one metadata field: prefers a matching org issue field (set on the issue
  // only), else a matching project field (set on the issue and PR items). Issue-field
  // API errors are downgraded to warnings so the run never crashes.
  const applyField = async ({
    label,
    names,
    value,
    isDate,
  }: {
    label: string
    names: string[]
    value: string
    isDate: boolean
  }): Promise<void> => {
    const issueField = findIssueFieldByNames(issueFields, names)
    if (issueField) {
      try {
        await setIssueField({ github, issueId: issue.node_id, field: issueField, value })
      } catch (error: unknown) {
        core.warning(`Could not set issue field '${issueField.name}': ${getErrorMessage(error)}`)
      }
      return
    }

    const projectField = findFieldByNames(fields, names)
    if (!projectField) {
      failOrWarn(`Required field '${label}' not found.`)
      return
    }

    try {
      if (isDate) {
        await setProjectDateField({
          github,
          projectId,
          itemId: issueItemId,
          fieldId: projectField.id,
          value,
        })
        await setProjectDateField({
          github,
          projectId,
          itemId: prItemId,
          fieldId: projectField.id,
          value,
        })
      } else {
        await setProjectGenericField({
          github,
          projectId,
          itemId: issueItemId,
          field: projectField,
          value,
        })
        await setProjectGenericField({
          github,
          projectId,
          itemId: prItemId,
          field: projectField,
          value,
        })
      }
    } catch (error: unknown) {
      if (isIssueFieldError(error)) {
        core.warning(
          `'${label}' is a GitHub issue field but no matching org issue field was found; skipped.`,
        )
        return
      }
      failOrWarn(`Could not set field '${projectField.name}': ${getErrorMessage(error)}`)
    }
  }

  await applyField({
    label: 'Start date',
    names: ['Start date', 'Start'],
    value: startDate,
    isDate: true,
  })
  await applyField({
    label: 'Target date',
    names: ['Target date', 'Target', 'Due date'],
    value: targetDate,
    isDate: true,
  })
  await applyField({
    label: 'Priority',
    names: ['Priority'],
    value: config.priorityValue,
    isDate: false,
  })
  await applyField({
    label: 'Estimate',
    names: ['Estimate', 'Estimation', 'Effort'],
    value: config.estimateValue,
    isDate: false,
  })
  await applyField({
    label: 'Size',
    names: ['Size', 'T-shirt size', 'Tshirt size', 'T shirt size'],
    value: config.sizeValue,
    isDate: false,
  })
}
