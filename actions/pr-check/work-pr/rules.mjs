// The work-PR rules: what a feat/fix/… PR into dev must look like before it is
// squash-merged — on top of what every PR needs (../rules.mjs).

import { types } from '../../../commitlint.config.mjs'
import { TITLE_PATTERN, checkTracking, code } from '../rules.mjs'

const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m
const ALLOWED_AUTHORS = ['OWNER', 'MEMBER', 'COLLABORATOR']

/**
 * @param pr              { title, body, head, base, authorAssociation, assignees: string[],
 *                          labels: string[], milestone: string | null, changedLines: number }
 * @param commitMessages  full messages of the PR's commits
 * @param projects        [{ owner, number }] the PR is on (read only when a board is set)
 * @param projectsError   why `projects` could not be read, if it could not
 * @param behindBy        commits on the base branch that the head does not have
 * @param config          prConfig(), with projectOwner defaulted to the repo owner
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

  if (!ALLOWED_AUTHORS.includes(pr.authorAssociation)) {
    fails.push(
      'Work PRs are opened by the repo owner, members and collaborators only ' +
        `(author association: ${code(pr.authorAssociation || 'NONE')}).`,
    )
  }

  fails.push(...checkTracking({ pr, projects, projectsError, config }))

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
