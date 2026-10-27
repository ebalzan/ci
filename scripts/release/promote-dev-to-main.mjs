#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import sharedVars from '../../actions/auto-work-items/dist/sharedVars.js'
import { bumpVersion, highestRelease, normalizeSubjectLine } from './release-utils.mjs'

const BASE_BRANCH = process.env.PROMOTION_BASE || 'main'
const HEAD_BRANCH = process.env.PROMOTION_HEAD || 'dev'

// The title takes the most significant Conventional Commits type among the
// promoted commits, so a refact-only promotion reads `refact:`, not `fix:`.
// feat leads because it is the only minor bump; every other type is a patch, so
// whichever wins, the title's release type still matches the computed bump (a
// breaking change adds `!`) and passes verify-pr-release-type.
const TITLE_TYPE_PRECEDENCE = [
  'feat',
  'fix',
  'refact',
  'perf',
  'revert',
  'build',
  'ci',
  'docs',
  'test',
  'style',
  'chore',
]

// Commit type → the type label auto-pr.yml puts on feature PRs. Colors and
// descriptions match TYPE_CONFIG in actions/auto-work-items/src/config.ts
// so neither automation rewrites the other's labels.
const TYPE_LABELS = {
  feat: { name: 'feat', color: '1D76DB', description: "Changes for 'feat' branches" },
  fix: { name: 'fix', color: 'D73A4A', description: "Changes for 'fix' branches" },
  docs: { name: 'docs', color: '5319E7', description: "Changes for 'docs' branches" },
  style: { name: 'style', color: 'C2E0C6', description: "Changes for 'style' branches" },
  refact: { name: 'refact', color: 'FBCA04', description: "Changes for 'refact' branches" },
  perf: { name: 'perf', color: 'F9D0C4', description: "Changes for 'perf' branches" },
  test: { name: 'test', color: '0E8A16', description: "Changes for 'test' branches" },
  build: { name: 'build', color: '0052CC', description: "Changes for 'build' branches" },
  ci: { name: 'ci', color: '0052CC', description: "Changes for 'ci' branches" },
  chore: { name: 'chore', color: 'BFD4F2', description: "Changes for 'chore' branches" },
  revert: { name: 'revert', color: 'E99695', description: "Changes for 'revert' branches" },
}

const RELEASE_LABEL = {
  name: 'release',
  color: '0E8A16',
  description: 'dev → main promotion PR',
}

function log(message) {
  console.log(`[promote] ${message}`)
}

function fail(message) {
  console.error(`[promote] ${message}`)
  process.exit(1)
}

function parseRepositorySlug(slug) {
  const [owner, repo] = `${slug || ''}`.split('/')

  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: "${slug}"`)
  }

  return { owner, repo }
}

async function githubRequest(path, options = {}) {
  const token = process.env.GITHUB_TOKEN

  if (!token) {
    throw new Error('Missing GITHUB_TOKEN.')
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ebalzan-ci-promote',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`GitHub API ${response.status} for ${path}: ${errorText}`)
  }

  return response.status === 204 ? null : response.json()
}

async function githubGraphql(query, variables) {
  const result = await githubRequest('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  })

  if (result?.errors?.length) {
    throw new Error(result.errors.map(error => error.message).join('; '))
  }

  return result.data
}

// No tag yet: package.json's version, or 0.0.0 for a repo without one (it is
// released tag-only, see release-main.mjs).
function getCurrentVersionFromPackage() {
  const path = join(process.cwd(), 'package.json')
  if (!existsSync(path)) return '0.0.0'
  return JSON.parse(readFileSync(path, 'utf8')).version || '0.0.0'
}

async function getCurrentVersion({ owner, repo }) {
  const tags = await githubRequest(`/repos/${owner}/${repo}/tags?per_page=100`)
  const versionTags = Array.isArray(tags)
    ? tags
        .map(tag => `${tag.name || ''}`)
        .filter(name => /^v\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    : []

  const latestTag = versionTags[versionTags.length - 1]
  return latestTag ? latestTag.replace(/^v/, '') : getCurrentVersionFromPackage()
}

// Adds the promotion PR to the Projects (v2) board that auto-pr.yml uses, so it
// is tracked like every other PR. addProjectV2ItemById returns the existing item
// when the PR is already on the board, so this is safe on every push. Needs a
// classic PAT with the `project` scope (GH_PROJECT_TOKEN); best-effort, so a
// board problem never blocks the promotion PR itself.
async function addToProject({ owner, pullRequest }) {
  const projectNumber = Number(process.env.AUTO_PROJECT_NUMBER || 0)
  const projectOwner = (process.env.AUTO_PROJECT_OWNER || owner).trim()

  if (!projectNumber) {
    log('AUTO_PROJECT_NUMBER not set; skipping project assignment.')
    return
  }

  try {
    const lookup = await githubGraphql(
      `query($login: String!, $number: Int!) {
        repositoryOwner(login: $login) {
          ... on Organization { projectV2(number: $number) { id title } }
          ... on User { projectV2(number: $number) { id title } }
        }
      }`,
      { login: projectOwner, number: projectNumber },
    )
    const project = lookup.repositoryOwner?.projectV2
    if (!project) {
      console.warn(`[promote] Project v2 #${projectNumber} not found for '${projectOwner}'.`)
      return
    }

    await githubGraphql(
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }`,
      { projectId: project.id, contentId: pullRequest.node_id },
    )
    log(`Promotion PR #${pullRequest.number} is on project '${project.title}'.`)
  } catch (error) {
    console.warn(
      `[promote] Could not add PR #${pullRequest.number} to project: ${error instanceof Error ? error.message : error}`,
    )
  }
}

function commitType(subject) {
  return subject.match(/^([a-z]+)(\([^)]+\))?!?: /)?.[1] ?? null
}

function resolveTitleType({ commits, releaseType }) {
  const types = new Set(commits.map(commit => commitType(commit.subject)))
  const type = TITLE_TYPE_PRECEDENCE.find(candidate => types.has(candidate)) ?? 'chore'
  return releaseType === 'major' ? `${type}!` : type
}

// Creates the label when missing. Existing labels are left alone: auto-pr.yml
// owns the type labels' look, and TYPE_LABELS already mirrors it.
async function ensureLabel({ owner, repo, label }) {
  const existing = await githubRequest(
    `/repos/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`,
  )
  if (existing) return

  try {
    await githubRequest(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify(label),
    })
  } catch (error) {
    // 422: a concurrent run created it first.
    if (!(error instanceof Error && error.message.startsWith('GitHub API 422'))) throw error
  }
}

async function resolveMilestoneNumber({ owner, repo }) {
  const title = (process.env.AUTO_MILESTONE_TITLE || '').trim().toLowerCase()
  if (!title) {
    log('AUTO_MILESTONE_TITLE not set; skipping milestone.')
    return null
  }

  const milestones = await githubRequest(
    `/repos/${owner}/${repo}/milestones?state=open&per_page=100`,
  )
  const match = (milestones || []).find(
    milestone => `${milestone.title || ''}`.trim().toLowerCase() === title,
  )
  if (!match) {
    console.warn(`[promote] No open milestone titled '${process.env.AUTO_MILESTONE_TITLE}'.`)
  }
  return match?.number ?? null
}

// Assignee, labels and milestone, mirroring what auto-pr.yml sets on feature
// PRs. The assignee is whoever pushed to dev (the merger of the feature PR);
// labels are one type label per commit type promoted, plus `release`, and are
// only ever added, so labels set by hand survive. Best-effort like the board:
// metadata problems never block the promotion PR itself.
async function syncMetadata({ owner, repo, pullRequest, commits }) {
  try {
    const labels = [
      RELEASE_LABEL,
      ...new Set(commits.map(commit => TYPE_LABELS[commitType(commit.subject)]).filter(Boolean)),
    ]
    for (const label of labels) {
      await ensureLabel({ owner, repo, label })
    }
    await githubRequest(`/repos/${owner}/${repo}/issues/${pullRequest.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: labels.map(label => label.name) }),
    })

    const assignee = (process.env.PROMOTION_ASSIGNEE || '').trim()
    if (assignee) {
      await githubRequest(`/repos/${owner}/${repo}/issues/${pullRequest.number}/assignees`, {
        method: 'POST',
        body: JSON.stringify({ assignees: [assignee] }),
      })
    }

    const milestone = await resolveMilestoneNumber({ owner, repo })
    if (milestone) {
      await githubRequest(`/repos/${owner}/${repo}/issues/${pullRequest.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ milestone }),
      })
    }

    log(
      `PR #${pullRequest.number}: labels ${labels.map(label => label.name).join(', ')}; ` +
        `assignee ${assignee || 'none'}; milestone ${milestone ?? 'none'}.`,
    )
  } catch (error) {
    console.warn(
      `[promote] Could not set metadata on PR #${pullRequest.number}: ${error instanceof Error ? error.message : error}`,
    )
  }
}

function buildBody({ nextTag, releaseType, commits }) {
  const lines = [
    `## Promote \`${HEAD_BRANCH}\` → \`${BASE_BRANCH}\``,
    '',
    `- Next release: **${nextTag}** (${releaseType})`,
    `- Commits to promote: ${commits.length}`,
    '',
    '> Opened automatically. The release bump is computed from the promoted commits at release time.',
    '',
    '### Included commits',
    ...commits.map(commit => `- ${commit.subject} (${commit.sha.slice(0, 7)})`),
  ]

  return `${lines.join('\n')}\n`
}

async function main() {
  // AUTO_* from the caller repo's variables (REPO_VARS_JSON), the rest from
  // config/actions.env — the same loader auto-work-items uses.
  sharedVars.applySharedVars({ core: { info: log, warning: log }, env: process.env })

  const { owner, repo } = parseRepositorySlug(process.env.GITHUB_REPOSITORY)

  const comparison = await githubRequest(
    `/repos/${owner}/${repo}/compare/${BASE_BRANCH}...${HEAD_BRANCH}`,
  )

  if (!comparison) {
    fail(`Could not compare ${BASE_BRANCH}...${HEAD_BRANCH}.`)
  }

  if ((comparison.ahead_by || 0) === 0) {
    log(`${HEAD_BRANCH} is not ahead of ${BASE_BRANCH}; nothing to promote.`)
    return
  }

  const commits = (comparison.commits || [])
    .filter(commit => (commit.parents || []).length < 2) // skip merge commits
    .map(commit => ({
      sha: commit.sha,
      message: commit.commit?.message || '',
      subject: normalizeSubjectLine(commit.commit?.message),
    }))
    .filter(commit => commit.subject)

  const releaseType = highestRelease(commits.map(commit => commit.message))
  const currentVersion = await getCurrentVersion({ owner, repo })
  const nextTag = `v${bumpVersion(currentVersion, releaseType === 'none' ? 'patch' : releaseType)}`
  const titleType = resolveTitleType({ commits, releaseType })
  const title = `${titleType}: promote ${HEAD_BRANCH} to ${BASE_BRANCH} (${nextTag})`
  const body = buildBody({ nextTag, releaseType, commits })

  const existing = await githubRequest(
    `/repos/${owner}/${repo}/pulls?base=${BASE_BRANCH}&head=${owner}:${HEAD_BRANCH}&state=open`,
  )
  const existingPullRequest = Array.isArray(existing) ? existing[0] : null

  if (existingPullRequest) {
    const updated = await githubRequest(
      `/repos/${owner}/${repo}/pulls/${existingPullRequest.number}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title, body }),
      },
    )
    log(`Updated promotion PR #${updated.number}: ${updated.html_url}`)
    await syncMetadata({ owner, repo, pullRequest: updated, commits })
    await addToProject({ owner, pullRequest: updated })
    return
  }

  const created = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, head: HEAD_BRANCH, base: BASE_BRANCH, body }),
  })
  log(`Opened promotion PR #${created.number}: ${created.html_url}`)
  await syncMetadata({ owner, repo, pullRequest: created, commits })
  await addToProject({ owner, pullRequest: created })
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})
