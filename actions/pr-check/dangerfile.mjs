// Danger entry point of the PR check: action.yml runs `danger ci --dangerfile`
// on this file. Danger puts its DSL (danger, fail, warn) on the global scope
// and awaits the default export. This file only gathers the PR's data; the
// rules of the PR's kind (PR_KIND) decide: work-pr/rules.mjs or
// release-pr/rules.mjs.

import process from 'node:process'

import { checkReleasePr } from './release-pr/rules.mjs'
import { prConfig } from './rules.mjs'
import { checkWorkPr } from './work-pr/rules.mjs'

const PROJECTS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        projectItems(first: 50) {
          nodes {
            project {
              number
              owner { ... on User { login } ... on Organization { login } }
            }
          }
        }
      }
    }
  }`

// The Projects (v2) boards the PR is on. A board owned by a personal account is
// only visible to a classic PAT with the project scope (PROJECT_TOKEN).
async function projectsOf({ owner, repo, number }) {
  const res = await fetch(process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${process.env.PROJECT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: PROJECTS_QUERY, variables: { owner, repo, number } }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.errors) {
    throw new Error(json.errors?.[0]?.message || `GitHub GraphQL API returned ${res.status}`)
  }
  return json.data.repository.pullRequest.projectItems.nodes
    .filter(node => node?.project)
    .map(({ project }) => ({ number: project.number, owner: project.owner?.login ?? '' }))
}

export default async function () {
  const { pr } = danger.github
  const owner = pr.base.repo.owner.login
  const config = prConfig(process.env)
  config.projectOwner ||= owner

  let projects = []
  let projectsError = ''
  if (config.projectNumber) {
    try {
      projects = await projectsOf({ owner, repo: pr.base.repo.name, number: pr.number })
    } catch (error) {
      projectsError = error instanceof Error ? error.message : String(error)
    }
  }

  const check = process.env.PR_KIND === 'release' ? checkReleasePr : checkWorkPr
  const { fails, warnings } = check({
    pr: {
      title: pr.title,
      body: pr.body ?? '',
      head: pr.head.ref,
      base: pr.base.ref,
      authorAssociation: pr.author_association,
      assignees: (pr.assignees ?? []).map(user => user.login),
      labels: (pr.labels ?? []).map(label => label.name),
      milestone: pr.milestone?.title ?? null,
      changedLines: (pr.additions ?? 0) + (pr.deletions ?? 0),
    },
    commitMessages: danger.git.commits.map(commit => commit.message),
    releaseTitle: process.env.RELEASE_TITLE ?? '',
    projects,
    projectsError,
    behindBy: Number.parseInt(process.env.BEHIND_BY ?? '', 10) || 0,
    config,
  })

  for (const message of fails) fail(message)
  for (const message of warnings) warn(message)
}
