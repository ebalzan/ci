import {
  analyzeBranchName,
  analyzeConventionalMessage,
  promotionBranches,
  supportedBranchTypes,
} from './release-utils.mjs'

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function main() {
  const pullRequestTitle = process.env.PR_TITLE
  const pullRequestHeadRef = process.env.PR_HEAD_REF
  const titleAnalysis = analyzeConventionalMessage(pullRequestTitle)
  const branchAnalysis = analyzeBranchName(pullRequestHeadRef)
  const isMajorOverride = titleAnalysis.release === 'major'

  if (!pullRequestTitle || !pullRequestHeadRef) {
    fail('Missing PR_TITLE or PR_HEAD_REF.')
  }

  // Promotion PRs (e.g. dev -> main) batch many changes, so the bump is
  // computed from the promoted commits at release time, not from the branch
  // name. Here we only require a valid Conventional Commits title.
  if (promotionBranches.includes(branchAnalysis.branch)) {
    if (titleAnalysis.release === 'none') {
      fail(
        [
          `Promotion PR from "${branchAnalysis.branch}" needs a Conventional Commits title.`,
          'Example: "feat: promote dev to main (v1.2.0)".',
          `PR title: ${pullRequestTitle}`,
        ].join('\n'),
      )
    }

    console.log(
      `Promotion branch "${branchAnalysis.branch}" accepted; release bump is computed from the promoted commits.`,
    )
    return
  }

  if (branchAnalysis.release === 'none') {
    fail(
      [
        `Could not determine a release type from branch "${branchAnalysis.branch || pullRequestHeadRef}".`,
        `Use a supported branch prefix: ${supportedBranchTypes.join(', ')}.`,
      ].join('\n'),
    )
  }

  if (titleAnalysis.release !== branchAnalysis.release && !isMajorOverride) {
    fail(
      [
        `PR title release type is "${titleAnalysis.release}", but branch "${branchAnalysis.branch}" requires "${branchAnalysis.release}" or an explicit breaking-change major.`,
        'Update the PR title so the squash commit produces the release bump implied by the branch type, or mark it as breaking with `!`.',
        '',
        `PR branch: ${branchAnalysis.branch}`,
        `PR title: ${pullRequestTitle}`,
      ].join('\n'),
    )
  }

  console.log(
    isMajorOverride
      ? `PR title release type "${titleAnalysis.release}" is accepted as an explicit breaking-change override for branch "${branchAnalysis.branch}".`
      : `PR title release type "${titleAnalysis.release}" matches branch "${branchAnalysis.branch}".`,
  )
}

await main()
