// The release-PR rules: what the dev → main PR actions/auto-pr opens must look
// like before it is merged with a merge commit — on top of what every PR needs
// (../rules.mjs).

import { TITLE_PATTERN, checkTracking, code } from '../rules.mjs'

// The label actions/auto-pr puts on the release PR.
export const RELEASE_LABEL = 'release'

/**
 * The release PR: dev → main, opened by actions/auto-pr. Its author is the bot
 * (or the GH_PROJECT_TOKEN owner) and its size is the whole release, so neither
 * is checked.
 *
 * @param pr            as for checkWorkPr (work-pr/rules.mjs)
 * @param releaseTitle  the title scripts/release-title.mjs computes for the
 *                      PR's head; '' when it found nothing to release
 * @param behindBy      commits on the release branch that dev does not have
 * @returns {{ fails: string[], warnings: string[] }}
 */
export function checkReleasePr({
  pr,
  releaseTitle,
  projects = [],
  projectsError = '',
  behindBy = 0,
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
        `${code(pr.head)} does not (the last release commit, with its package.json version): ` +
        `merge ${code(config.releaseBranch)} into ${code(pr.head)}. The Release workflow does ` +
        'it after every release — re-run its failed job.',
    )
  }

  if (TITLE_PATTERN.exec(releaseTitle)?.[2]) {
    warnings.push('Merging this releases a new **major** version. Make sure that is intended.')
  }

  return { fails, warnings }
}
