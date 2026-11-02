// The release-PR rules: what the dev → main PR actions/auto-pr opens must look
// like before it ships — on top of what every PR needs (../rules.mjs). It is
// never merged with a GitHub button: the SHIP_LABEL makes the Release workflow
// fast-forward main to dev, so dev must contain main and have no merge commit.

import { TITLE_PATTERN, checkTracking, code } from '../rules.mjs'

// The label actions/auto-pr puts on the release PR.
export const RELEASE_LABEL = 'release'
// The label that ships it (templates/.github/workflows/release.yml).
export const SHIP_LABEL = 'ship'

/**
 * The release PR: dev → main, opened by actions/auto-pr. Its author is the bot
 * (or the GH_PROJECT_TOKEN owner) and its size is the whole release, so neither
 * is checked.
 *
 * @param pr            as for checkWorkPr (work-pr/rules.mjs)
 * @param releaseTitle  the title scripts/release-title.mjs computes for the
 *                      PR's head; '' when it found nothing to release
 * @param behindBy      commits on the release branch that dev does not have
 * @param mergeCommits  merge commits on dev that the release branch does not have
 * @returns {{ fails: string[], warnings: string[], messages: string[] }}
 */
export function checkReleasePr({
  pr,
  releaseTitle,
  projects = [],
  projectsError = '',
  behindBy = 0,
  mergeCommits = 0,
  config,
}) {
  const fails = []
  const warnings = []

  if (pr.base !== config.releaseBranch) {
    fails.push(
      `The release PR merges ${code(config.baseBranch)} into ${code(config.releaseBranch)}, ` +
        `not ${code(pr.base)}: change the base branch.`,
    )
  }

  if (!releaseTitle) {
    fails.push(
      `There is no Conventional Commit on ${code(config.baseBranch)} since the last release: ` +
        'nothing to release.',
    )
  } else if (pr.title !== releaseTitle) {
    fails.push(
      `The title must be ${code(releaseTitle)}: it names the release merging cuts, and ` +
        'the Release workflow checks it against main. Push to dev (or re-run Auto PR) to ' +
        'restore it.',
    )
  }

  if (!pr.labels.some(label => label.toLowerCase() === RELEASE_LABEL)) {
    fails.push(`Add the ${code(RELEASE_LABEL)} label.`)
  }

  fails.push(...checkTracking({ pr, projects, projectsError, config }))

  if (behindBy > 0) {
    fails.push(
      `${code(config.releaseBranch)} has ${behindBy} commit${behindBy > 1 ? 's' : ''} that ` +
        `${code(pr.head)} does not, so it cannot fast-forward to ${code(pr.head)}: it moved ` +
        'outside a release (the Release workflow leaves both on the release commit). Bring ' +
        `${code(pr.head)} up to ${code(config.releaseBranch)} without a merge commit.`,
    )
  }

  if (mergeCommits > 0) {
    fails.push(
      `${code(pr.head)} has ${mergeCommits} merge commit${mergeCommits > 1 ? 's' : ''}: ` +
        `history must stay linear, so ${code(config.releaseBranch)} can fast-forward to it.`,
    )
  }

  if (TITLE_PATTERN.exec(releaseTitle)?.groups.breaking) {
    warnings.push('Merging this releases a new **major** version. Make sure that is intended.')
  }

  const messages = fails.length
    ? []
    : [
        `To release, add the ${code(SHIP_LABEL)} label: the Release workflow fast-forwards ` +
          `${code(config.releaseBranch)} to ${code(pr.head)}. Do not use the merge button — ` +
          `squash and rebase rewrite ${code(pr.head)}'s commits.`,
      ]

  return { fails, warnings, messages }
}
