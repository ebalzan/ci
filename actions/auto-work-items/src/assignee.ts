import type { AutoWorkItemsConfig, CoreClient, GitHubClient } from './types'
import { getErrorMessage } from './utils'

export async function resolveLatestCommitAssignee({
  github,
  core,
  config,
}: {
  github: GitHubClient
  core: CoreClient
  config: AutoWorkItemsConfig
}): Promise<string | null> {
  try {
    const { data: commits } = await github.rest.repos.listCommits({
      owner: config.owner,
      repo: config.repo,
      sha: config.branch,
      per_page: 1,
    })

    const latest = commits[0]
    if (!latest) {
      core.warning(`No commits found for branch '${config.branch}'. Skipping assignee sync.`)
      return null
    }

    const assignee = latest.author?.login || latest.committer?.login || null
    if (!assignee) {
      core.warning(
        `Latest commit on branch '${config.branch}' has no linked GitHub user. Skipping assignee sync.`,
      )
      return null
    }

    return assignee
  } catch (error: unknown) {
    core.warning(`Could not resolve latest commit author: ${getErrorMessage(error)}`)
    return null
  }
}

export async function syncAssignee({
  github,
  core,
  config,
  issueNumber,
  assignee,
}: {
  github: GitHubClient
  core: CoreClient
  config: AutoWorkItemsConfig
  issueNumber: number
  assignee: string | null
}): Promise<void> {
  if (!assignee) return

  try {
    await github.rest.issues.update({
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      assignees: [assignee],
    })
  } catch (error: unknown) {
    core.warning(
      `Could not set assignee '${assignee}' on #${issueNumber}: ${getErrorMessage(error)}`,
    )
  }
}
