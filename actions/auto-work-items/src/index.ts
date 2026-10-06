import { resolveLatestCommitAssignee, syncAssignee } from './assignee'
import { buildConfig } from './config'
import { collectBranchDigest, generateDescription } from './describe'
import { upsertIssue } from './issue'
import { ensureLabels } from './labels'
import { resolveMilestoneNumber } from './milestone'
import { upsertPr } from './pr'
import { syncProjectMetadata } from './project'
import { applySharedVars } from './sharedVars'
import type { CoreClient, GitHubClient, WorkflowContext } from './types'

async function runAutoWorkItems({
  github,
  context,
  core,
}: {
  github: GitHubClient
  context: WorkflowContext
  core: CoreClient
}): Promise<void> {
  applySharedVars({ core, env: process.env })
  const config = buildConfig({ context, core, env: process.env })
  if (config.skip) return

  await ensureLabels({
    github,
    core,
    config,
    labels: Array.from(new Set([...config.issueLabels, ...config.prLabels])),
  })

  const milestoneNumber = await resolveMilestoneNumber({ github, core, config })

  const digest = await collectBranchDigest({ github, core, config })
  const description = digest ? await generateDescription({ core, config, digest }) : null

  const issue = await upsertIssue({ github, core, config, milestoneNumber, description })
  const pr = await upsertPr({
    github,
    core,
    config,
    issueNumber: issue.number,
    milestoneNumber,
    description,
  })
  const assignee = await resolveLatestCommitAssignee({ github, core, config })

  await syncAssignee({ github, core, config, issueNumber: issue.number, assignee })
  await syncAssignee({ github, core, config, issueNumber: pr.number, assignee })

  await syncProjectMetadata({ github, core, config, issue, pr })

  core.notice(
    `Issue #${issue.number} and PR #${pr.number} are synced for branch '${config.branch}'.`,
  )
}

export default runAutoWorkItems
