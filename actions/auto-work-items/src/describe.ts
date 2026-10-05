import type { AutoWorkItemsConfig, CoreClient, GitHubClient } from './types'
import { getErrorMessage } from './utils'

// Minimal fetch typing so this compiles without pulling in the DOM lib.
// Node 24 (the workflow runtime) provides a global fetch.
declare const fetch: (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
  },
) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}>

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-sonnet-5-5'
// Sonnet 5.5 always thinks; `low` effort keeps it fast and cheap for a diff
// summary. Haiku 4.5 rejects the effort parameter, so it is never sent there.
const DEFAULT_EFFORT = 'low'
// Headroom for thinking plus the ~500-token description.
const MAX_OUTPUT_TOKENS = 4000
const MAX_DIFF_CHARS = 60000
const MAX_COMMITS = 50

export type BranchDigest = {
  commitSummaries: string[]
  changedFiles: string[]
  diff: string
}

/**
 * Compares the branch against its base and returns the commits + diff that
 * describe the work. Returns null when there is nothing meaningful yet (e.g. the
 * first empty push), in which case callers fall back to the static template.
 */
export async function collectBranchDigest({
  github,
  core,
  config,
}: {
  github: GitHubClient
  core: CoreClient
  config: AutoWorkItemsConfig
}): Promise<BranchDigest | null> {
  try {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      owner: config.owner,
      repo: config.repo,
      basehead: `${config.base}...${config.branch}`,
    })

    const commits = (data.commits || []).slice(-MAX_COMMITS)
    const files = data.files || []

    if (commits.length === 0 && files.length === 0) {
      core.info('No commits or file changes vs base; using static description.')
      return null
    }

    const commitSummaries = commits.map(commit => {
      const lines = (commit.commit?.message || '').trim().split('\n')
      const subject = lines[0] || '(no message)'
      const body = lines.slice(1).join('\n').trim()
      return body ? `- ${subject}\n  ${body.replace(/\n/g, '\n  ')}` : `- ${subject}`
    })

    const changedFiles = files.map(
      file => `${file.status} ${file.filename} (+${file.additions}/-${file.deletions})`,
    )

    let diff = files
      .map(file => `--- ${file.filename}\n${file.patch || '(no textual diff)'}`)
      .join('\n\n')
    if (diff.length > MAX_DIFF_CHARS) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)`
    }

    return { commitSummaries, changedFiles, diff }
  } catch (error: unknown) {
    core.warning(`Failed to collect branch digest: ${getErrorMessage(error)}`)
    return null
  }
}

/**
 * Asks Claude to write a proper "what & why" description from the branch digest.
 * Returns null (so callers fall back to the static template) when no API key is
 * configured or the request fails.
 */
export async function generateDescription({
  core,
  config,
  digest,
}: {
  core: CoreClient
  config: AutoWorkItemsConfig
  digest: BranchDigest
}): Promise<string | null> {
  const apiKey = config.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    core.info('ANTHROPIC_API_KEY not set; using static description.')
    return null
  }

  const model = (config.env.AUTO_DESCRIBE_MODEL || DEFAULT_MODEL).trim()
  const effort = model.startsWith('claude-haiku')
    ? ''
    : (config.env.AUTO_DESCRIBE_EFFORT || DEFAULT_EFFORT).trim()

  const prompt = [
    `You are writing the description for a GitHub issue and pull request that track ` +
      `work on the branch \`${config.branch}\` (type: ${config.branchType}), which merges ` +
      `into \`${config.base}\`.`,
    '',
    'Write a clear, concise Markdown description of what this branch does, based on the',
    'commits and diff below. Use this structure:',
    '',
    '## Summary',
    'One or two sentences on the goal and outcome.',
    '',
    '## Changes',
    'A short bullet list of the notable changes. Group related edits and explain intent —',
    'do not just restate filenames.',
    '',
    'Rules: output only the Markdown body — no preamble, no surrounding code fences, no',
    'top-level title. If the diff is empty or trivial, keep it brief.',
    '',
    '### Commits',
    digest.commitSummaries.join('\n') || '(none)',
    '',
    '### Changed files',
    digest.changedFiles.join('\n') || '(none)',
    '',
    '### Diff',
    digest.diff || '(none)',
  ].join('\n')

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(effort ? { output_config: { effort } } : {}),
        system:
          'You are a precise technical writer. Respond with only the requested Markdown ' +
          'description and nothing else.',
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      core.warning(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`)
      return null
    }

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[]
      stop_reason?: string
    }
    if (data.stop_reason === 'max_tokens') {
      core.warning(
        `Description hit max_tokens (${MAX_OUTPUT_TOKENS}) and may be cut off; lower AUTO_DESCRIBE_EFFORT.`,
      )
    }
    const text = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text || '')
      .join('')
      .trim()

    if (!text) {
      core.warning('Anthropic API returned an empty description; using static description.')
      return null
    }

    return text
  } catch (error: unknown) {
    core.warning(`Failed to generate description: ${getErrorMessage(error)}`)
    return null
  }
}

/**
 * Builds the issue body. Falls back to the static template (which already
 * contains the marker) when no generated description is available.
 */
export function composeIssueBody(description: string | null, config: AutoWorkItemsConfig): string {
  if (!description) return config.issueBody

  return [
    description.trim(),
    '',
    '## Context',
    `- Branch: \`${config.branch}\``,
    `- Type: \`${config.branchType}\``,
    `- Base: \`${config.base}\``,
    '',
    `Marker: ${config.marker}`,
  ].join('\n')
}

/**
 * Builds the PR body, always preserving the `Closes #N` link and the marker.
 */
export function composePrBody(
  description: string | null,
  config: AutoWorkItemsConfig,
  issueNumber: number,
): string {
  const head = description ? description.trim() : `Auto-created PR for branch \`${config.branch}\`.`

  return [head, '', `Closes #${issueNumber}`, '', `Marker: ${config.marker}`].join('\n')
}
