// The work-PR rules: what a feat/fix/… PR into dev must look like before it is
// squash-merged. Pure — no GitHub calls — so test/work-pr.test.mjs runs them on
// plain objects; dangerfile.mjs gathers the PR's data and reports the result.
// The title and commit FORMAT is commitlint's job (the steps before Danger);
// these rules cover what commitlint cannot see.

import { types } from '../../commitlint.config.mjs'

const TITLE_PATTERN = /^(\w+)(?:\([^)]+\))?(!)?: \S/
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m
const ALLOWED_AUTHORS = ['OWNER', 'MEMBER', 'COLLABORATOR']
const DEFAULT_MAX_CHANGED_LINES = 500

// The AUTO_* knobs the rules read (repo variables over config/actions.env).
export function workPrConfig(env) {
  const maxChangedLines = Number.parseInt(env.AUTO_MAX_CHANGED_LINES ?? '', 10)
  return {
    baseBranch: (env.AUTO_BASE_BRANCH || 'dev').trim(),
    milestoneTitle: (env.AUTO_MILESTONE_TITLE || '').trim(),
    projectNumber: Number.parseInt(env.AUTO_PROJECT_NUMBER ?? '', 10) || 0,
    projectOwner: (env.AUTO_PROJECT_OWNER || '').trim(),
    maxChangedLines: maxChangedLines > 0 ? maxChangedLines : DEFAULT_MAX_CHANGED_LINES,
  }
}

const code = value => `\`${value}\``

/**
 * @param pr              { title, body, head, base, authorAssociation, assignees: string[],
 *                          labels: string[], milestone: string | null, changedLines: number }
 * @param commitMessages  full messages of the PR's commits
 * @param projects        [{ owner, number }] the PR is on (read only when a board is set)
 * @param projectsError   why `projects` could not be read, if it could not
 * @param behindBy        commits on the base branch that the head does not have
 * @param config          workPrConfig(), with projectOwner defaulted to the repo owner
 * @returns {{ fails: string[], warnings: string[] }}
 */
export function checkWorkPr({
  pr,
  commitMessages = [],
  projects = [],
  projectsError = '',
  behindBy = 0,
  config,
}) {
  const fails = []
  const warnings = []

  if (pr.base !== config.baseBranch) {
    fails.push(
      `Work PRs merge into ${code(config.baseBranch)}, not ${code(pr.base)}: change the base branch.`,
    )
  }

  const [branchType, ...rest] = pr.head.split('/')
  const branchOk = types.includes(branchType) && rest.join('/') !== ''
  if (!branchOk) {
    fails.push(
      `Branch ${code(pr.head)} is not ${code('<type>/<description>')} with a type of ` +
        `${types.map(code).join(', ')}: push the work to a correctly named branch.`,
    )
  }

  const title = pr.title.match(TITLE_PATTERN)
  if (branchOk && title?.[1] !== branchType) {
    fails.push(
      `The title must start with ${code(`${branchType}:`)} (or ${code(`${branchType}(scope):`)}, ` +
        `${code(`${branchType}!:`)} for a breaking change) to match branch ${code(pr.head)}: ` +
        'it becomes the squash commit that drives the release.',
    )
  }

  const typeLabels = pr.labels.map(label => label.toLowerCase()).filter(l => types.includes(l))
  if (branchOk && !typeLabels.includes(branchType)) {
    fails.push(`Add the ${code(branchType)} label.`)
  }
  const extraTypeLabels = typeLabels.filter(label => label !== branchType)
  if (branchOk && extraTypeLabels.length > 0) {
    fails.push(
      `Remove the ${extraTypeLabels.map(code).join(', ')} label${extraTypeLabels.length > 1 ? 's' : ''}: ` +
        `a work PR carries one type label, its branch's (${code(branchType)}).`,
    )
  }

  if (pr.assignees.length === 0) {
    fails.push('Assign the PR to whoever is responsible for it.')
  }

  if (!ALLOWED_AUTHORS.includes(pr.authorAssociation)) {
    fails.push(
      'Work PRs are opened by the repo owner, members and collaborators only ' +
        `(author association: ${code(pr.authorAssociation || 'NONE')}).`,
    )
  }

  if (
    config.milestoneTitle &&
    (pr.milestone ?? '').trim().toLowerCase() !== config.milestoneTitle.toLowerCase()
  ) {
    fails.push(
      `Set the milestone to ${code(config.milestoneTitle)} (AUTO_MILESTONE_TITLE)` +
        (pr.milestone ? `, not ${code(pr.milestone)}.` : '.'),
    )
  }

  if (config.projectNumber) {
    const board = `project #${config.projectNumber} of ${code(config.projectOwner)}`
    if (projectsError) {
      fails.push(`Could not check that the PR is on ${board}: ${projectsError}`)
    } else if (
      !projects.some(
        project =>
          project.number === config.projectNumber &&
          project.owner.toLowerCase() === config.projectOwner.toLowerCase(),
      )
    ) {
      fails.push(`Add the PR to ${board} (AUTO_PROJECT_NUMBER).`)
    }
  }

  if (!(pr.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()) {
    fails.push('Describe the change in the PR description.')
  }

  if (pr.changedLines > config.maxChangedLines) {
    warnings.push(
      `This PR changes ${pr.changedLines} lines (more than ${config.maxChangedLines}): ` +
        'consider splitting it.',
    )
  }

  const breakingCommit = commitMessages.find(message => BREAKING_FOOTER.test(message))
  if (title?.[2] || breakingCommit) {
    const why = title?.[2]
      ? `the title's ${code('!')}`
      : `the BREAKING CHANGE footer in ${code(breakingCommit.split('\n')[0])}`
    warnings.push(
      `Merging this releases a new **major** version (${why}). Make sure that is intended.`,
    )
  }

  if (behindBy > 0) {
    warnings.push(
      `${code(pr.head)} is ${behindBy} commit${behindBy > 1 ? 's' : ''} behind ` +
        `${code(pr.base)}: rebase onto it so the checks see the current ${code(pr.base)}.`,
    )
  }

  return { fails, warnings }
}
