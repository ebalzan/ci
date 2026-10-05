#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import {
  analyzeConventionalMessage,
  bumpVersion,
  highestRelease,
  normalizeSubjectLine,
} from './release-utils.mjs'

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function log(message) {
  console.log(`[release] ${message}`)
}

function fail(message) {
  console.error(`[release] ${message}`)
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
      'User-Agent': 'tracebim-ci-release-workflow',
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

function getLatestReleaseTag() {
  const tags = run('git', ['tag', '--sort=-version:refname'])
    .split('\n')
    .map(tag => tag.trim())
    .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))

  return tags[0] || null
}

function getCurrentVersion(previousTag) {
  if (previousTag) {
    return previousTag.replace(/^v/, '')
  }

  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  )
  return packageJson.version
}

function getHeadCommitMessage() {
  return run('git', ['log', '-1', '--pretty=%B'])
}

// Full commit messages landed since the previous release, excluding merge
// commits (which are not Conventional Commits) so the bump reflects the actual
// changes being released. Records are NUL-separated to keep multi-line bodies
// (e.g. BREAKING CHANGE footers) intact.
function getCommitMessagesSince(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const output = run('git', ['log', range, '--no-merges', '--pretty=format:%B%x00'])

  return output
    .split('\0')
    .map(message => message.trim())
    .filter(Boolean)
}

function determineReleasePlan({ commitMessages, pullRequest, headCommitMessage }) {
  // The bump is derived from the Conventional Commits landed since the last
  // release. This is branch-agnostic, so it works for feature -> main as well
  // as batched dev -> main promotions where the source branch name ("dev")
  // carries no release semantics.
  const scannedMessages = commitMessages.length > 0 ? commitMessages : [headCommitMessage]
  const releaseType = highestRelease(scannedMessages)

  if (releaseType === 'none') {
    throw new Error(
      [
        'Could not determine a release type from the commits since the last release.',
        'At least one Conventional Commit (feat/fix/etc.) is required.',
        `Landed commit: ${normalizeSubjectLine(headCommitMessage) || '(empty)'}`,
      ].join('\n'),
    )
  }

  const titleSubject = pullRequest
    ? analyzeConventionalMessage(pullRequest.title).subject
    : normalizeSubjectLine(headCommitMessage)

  return {
    releaseType,
    titleSubject,
    branchName: pullRequest?.head?.ref || null,
    pullRequestNumber: pullRequest?.number || null,
    pullRequestUrl: pullRequest?.html_url || null,
  }
}

async function getAssociatedPullRequest({ owner, repo, sha, refName }) {
  const pulls = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}/pulls`)

  if (!Array.isArray(pulls) || pulls.length === 0) {
    return null
  }

  const pullRequest =
    pulls.find(candidate => candidate.base?.ref === refName) ||
    pulls.find(candidate => candidate.merged_at) ||
    pulls[0]

  return pullRequest
}

async function getPullRequestCommits({ owner, repo, pullRequestNumber }) {
  const commits = []
  let page = 1

  while (true) {
    const pageCommits = await githubRequest(
      `/repos/${owner}/${repo}/pulls/${pullRequestNumber}/commits?per_page=100&page=${page}`,
    )

    if (!Array.isArray(pageCommits) || pageCommits.length === 0) {
      break
    }

    commits.push(...pageCommits)
    page += 1
  }

  return commits
}

function buildReleaseNotes({
  nextTag,
  previousTag,
  releaseType,
  pullRequest,
  pullRequestCommits,
  titleSubject,
  headSubject,
}) {
  const lines = [`## ${nextTag}`, '']

  if (pullRequest) {
    lines.push(`- PR: #${pullRequest.number} ${pullRequest.title}`)
    lines.push(`- Source branch: ${pullRequest.head.ref}`)
  }

  lines.push(`- Release type: ${releaseType}`)

  if (previousTag) {
    lines.push(`- Previous tag: ${previousTag}`)
  }

  lines.push(`- Landed commit: ${headSubject}`)

  if (titleSubject && titleSubject !== headSubject) {
    lines.push(`- Release title source: ${titleSubject}`)
  }

  const commitLines = pullRequestCommits
    .map(commit => {
      const subject = normalizeSubjectLine(commit.commit?.message)

      if (!subject) {
        return null
      }

      return `- ${subject} (${commit.sha.slice(0, 7)})`
    })
    .filter(Boolean)

  if (commitLines.length > 0) {
    lines.push('', '### Included PR commits', ...commitLines)
  }

  return `${lines.join('\n')}\n`
}

async function createOrUpdateGithubRelease({ owner, repo, tag, targetCommitish, body }) {
  const existingRelease = await githubRequest(`/repos/${owner}/${repo}/releases/tags/${tag}`)

  if (existingRelease) {
    await githubRequest(`/repos/${owner}/${repo}/releases/${existingRelease.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        body,
        name: `Release ${tag}`,
        target_commitish: targetCommitish,
      }),
    })
    log(`Updated GitHub release ${tag}.`)
    return
  }

  await githubRequest(`/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      body,
      draft: false,
      name: `Release ${tag}`,
      prerelease: false,
      tag_name: tag,
      target_commitish: targetCommitish,
    }),
  })

  log(`Created GitHub release ${tag}.`)
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY
  const sha = process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD'])
  const refName = process.env.GITHUB_REF_NAME || 'main'
  const { owner, repo } = parseRepositorySlug(repository)
  const headCommitMessage = getHeadCommitMessage()
  const headSubject = normalizeSubjectLine(headCommitMessage)

  if (headSubject.startsWith('chore(release):')) {
    log('Release commit detected. Skipping.')
    return
  }

  const previousTag = getLatestReleaseTag()
  const currentVersion = getCurrentVersion(previousTag)
  const commitMessages = getCommitMessagesSince(previousTag)
  const pullRequest = await getAssociatedPullRequest({ owner, repo, sha, refName })
  const releasePlan = determineReleasePlan({ commitMessages, pullRequest, headCommitMessage })
  const pullRequestCommits =
    pullRequest && releasePlan.pullRequestNumber
      ? await getPullRequestCommits({
          owner,
          repo,
          pullRequestNumber: releasePlan.pullRequestNumber,
        })
      : []
  const nextVersion = bumpVersion(currentVersion, releasePlan.releaseType)
  const nextTag = `v${nextVersion}`
  const releaseNotes = buildReleaseNotes({
    nextTag,
    previousTag,
    releaseType: releasePlan.releaseType,
    pullRequest,
    pullRequestCommits,
    titleSubject: releasePlan.titleSubject,
    headSubject,
  })

  log(
    [
      `previous=${previousTag || 'none'}`,
      `next=${nextTag}`,
      `type=${releasePlan.releaseType}`,
      `branch=${releasePlan.branchName || 'direct-main'}`,
      `sha=${sha.slice(0, 7)}`,
    ].join(' '),
  )

  run('npm', ['version', nextVersion, '--no-git-tag-version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  run('git', ['add', 'package.json', 'package-lock.json'])
  run('git', ['commit', '-m', `chore(release): ${nextVersion}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const releaseCommitSha = run('git', ['rev-parse', 'HEAD'])
  run('git', ['tag', '-a', nextTag, '-m', `Release ${nextTag}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  run('git', ['push', 'origin', `HEAD:${refName}`, '--follow-tags'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await createOrUpdateGithubRelease({
    owner,
    repo,
    tag: nextTag,
    targetCommitish: releaseCommitSha,
    body: releaseNotes,
  })
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})
