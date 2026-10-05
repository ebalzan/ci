import { composePrBody } from './describe'
import type { AutoWorkItemsConfig, CoreClient, GitHubClient, GitHubPullRequest } from './types'

export async function upsertPr({
  github,
  core,
  config,
  issueNumber,
  milestoneNumber,
  description,
}: {
  github: GitHubClient
  core: CoreClient
  config: AutoWorkItemsConfig
  issueNumber: number
  milestoneNumber: number | null
  description: string | null
}): Promise<GitHubPullRequest> {
  const headQualified = `${config.owner}:${config.branch}`
  const desiredBody = composePrBody(description, config, issueNumber)

  const { data: openPulls } = await github.rest.pulls.list({
    owner: config.owner,
    repo: config.repo,
    state: 'open',
    head: headQualified,
    base: config.base,
    per_page: 1,
  })

  let pr: GitHubPullRequest

  if (openPulls.length > 0) {
    pr = openPulls[0]
    core.info(`Using existing PR #${pr.number}`)

    const closesLine = `Closes #${issueNumber}`
    const shouldUpdateTitle = pr.title !== config.prTitle

    let nextBody: string
    let shouldUpdateBody: boolean
    if (description) {
      // Regenerate the body on every push so it reflects the current work.
      nextBody = desiredBody
      shouldUpdateBody = pr.body !== desiredBody
    } else {
      // No generated description — preserve the existing body and only ensure the
      // `Closes #N` link and marker are present.
      const bodyLines = [pr.body || '']
      if (!pr.body || !pr.body.includes(closesLine)) {
        bodyLines.push(closesLine)
      }
      if (!pr.body || !pr.body.includes(config.marker)) {
        bodyLines.push(`Marker: ${config.marker}`)
      }
      nextBody = bodyLines.join('\n\n').trim()
      shouldUpdateBody =
        !pr.body || !pr.body.includes(closesLine) || !pr.body.includes(config.marker)
    }

    if (shouldUpdateBody || shouldUpdateTitle) {
      const { data: updated } = await github.rest.pulls.update({
        owner: config.owner,
        repo: config.repo,
        pull_number: pr.number,
        body: shouldUpdateBody ? nextBody : undefined,
        title: shouldUpdateTitle ? config.prTitle : undefined,
      })
      pr = updated
    }
  } else {
    const { data: created } = await github.rest.pulls.create({
      owner: config.owner,
      repo: config.repo,
      title: config.prTitle,
      head: config.branch,
      base: config.base,
      body: desiredBody,
      draft: false,
    })
    pr = created
    core.info(`Created PR #${pr.number}`)
  }

  await github.rest.issues.setLabels({
    owner: config.owner,
    repo: config.repo,
    issue_number: pr.number,
    labels: config.prLabels,
  })

  if (milestoneNumber) {
    await github.rest.issues.update({
      owner: config.owner,
      repo: config.repo,
      issue_number: pr.number,
      milestone: milestoneNumber,
    })
  }

  return pr
}
