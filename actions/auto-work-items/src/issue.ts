import { composeIssueBody } from './describe'
import type { AutoWorkItemsConfig, CoreClient, GitHubClient, GitHubIssue } from './types'

async function findOpenIssueByMarker({
  github,
  config,
}: {
  github: GitHubClient
  config: AutoWorkItemsConfig
}): Promise<GitHubIssue | null> {
  const query = `repo:${config.owner}/${config.repo} is:issue is:open in:body "${config.marker}"`

  const { data } = await github.rest.search.issuesAndPullRequests({
    q: query,
    per_page: 1,
  })

  const issue = data.items.find(item => !item.pull_request)
  if (!issue) return null

  const { data: fullIssue } = await github.rest.issues.get({
    owner: config.owner,
    repo: config.repo,
    issue_number: issue.number,
  })

  return fullIssue
}

export async function upsertIssue({
  github,
  core,
  config,
  milestoneNumber,
  description,
}: {
  github: GitHubClient
  core: CoreClient
  config: AutoWorkItemsConfig
  milestoneNumber: number | null
  description: string | null
}): Promise<GitHubIssue> {
  const existing = await findOpenIssueByMarker({ github, config })
  const desiredBody = composeIssueBody(description, config)

  if (existing) {
    let issue = existing
    core.info(`Using existing issue #${issue.number}`)

    await github.rest.issues.setLabels({
      owner: config.owner,
      repo: config.repo,
      issue_number: issue.number,
      labels: config.issueLabels,
    })

    const nextUpdate: {
      milestone?: number
      title?: string
      body?: string
    } = {}

    if (milestoneNumber && issue.milestone?.number !== milestoneNumber) {
      nextUpdate.milestone = milestoneNumber
    }

    if (issue.title !== config.issueTitle) {
      nextUpdate.title = config.issueTitle
    }

    if (description) {
      // Regenerate the body on every push so it reflects the current work.
      if (issue.body !== desiredBody) {
        nextUpdate.body = desiredBody
      }
    } else if (!issue.body || !issue.body.includes(config.marker)) {
      // No generated description available — don't clobber an existing good body;
      // just ensure the marker is present.
      nextUpdate.body = `${issue.body || ''}\n\n${config.issueBody}`.trim()
    }

    if (Object.keys(nextUpdate).length > 0) {
      const { data: updated } = await github.rest.issues.update({
        owner: config.owner,
        repo: config.repo,
        issue_number: issue.number,
        ...nextUpdate,
      })
      issue = updated
    }

    return issue
  }

  const { data: created } = await github.rest.issues.create({
    owner: config.owner,
    repo: config.repo,
    title: config.issueTitle,
    body: desiredBody,
    labels: config.issueLabels,
    milestone: milestoneNumber || undefined,
  })

  core.info(`Created issue #${created.number}`)
  return created
}
