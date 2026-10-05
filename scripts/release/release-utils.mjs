// Accepted branch prefixes. Keep in sync with TYPE_CONFIG in
// .github/scripts/auto-work-items/src/config.ts.
const branchReleaseTypes = new Map([
  ['feat', 'minor'],
  ['fix', 'patch'],
  ['docs', 'patch'],
  ['style', 'patch'],
  ['refact', 'patch'],
  ['perf', 'patch'],
  ['test', 'patch'],
  ['build', 'patch'],
  ['ci', 'patch'],
  ['chore', 'patch'],
  ['revert', 'patch'],
])

const supportedBranchTypes = Array.from(branchReleaseTypes.keys())

// Branches that act as release-promotion sources into main. Their bump is
// derived from the commits being promoted, not from the branch name.
const promotionBranches = ['dev']

const releaseRank = new Map([
  ['none', 0],
  ['patch', 1],
  ['minor', 2],
  ['major', 3],
])

function normalizeSubjectLine(message) {
  const normalizedMessage = `${message || ''}`.trim()
  const [subject = ''] = normalizedMessage.split('\n')

  return subject.trim().replace(/\s+\(#\d+\)$/, '')
}

function analyzeConventionalMessage(message) {
  const normalizedMessage = `${message || ''}`.trim()
  const subject = normalizeSubjectLine(normalizedMessage)
  const headerMatch = subject.match(/^([a-z]+)(\([^)]+\))?(!)?: .+/)
  const hasBreakingChange = /^BREAKING[ -]CHANGE:/m.test(normalizedMessage)

  if (hasBreakingChange) {
    return { release: 'major', subject }
  }

  if (!headerMatch) {
    return { release: 'none', subject }
  }

  const [, type, , isBreaking] = headerMatch

  if (isBreaking) {
    return { release: 'major', subject }
  }

  if (type === 'feat') {
    return { release: 'minor', subject }
  }

  if (
    ['fix', 'perf', 'docs', 'style', 'refact', 'test', 'build', 'ci', 'chore', 'revert'].includes(
      type,
    )
  ) {
    return { release: 'patch', subject }
  }

  return { release: 'none', subject }
}

// Returns the strongest release type implied by a list of commit messages.
// Used to compute a single bump for a batch of commits (e.g. a dev -> main
// promotion) following Conventional Commits precedence: major > minor > patch.
function highestRelease(messages) {
  let strongest = 'none'

  for (const message of messages) {
    const { release } = analyzeConventionalMessage(message)

    if ((releaseRank.get(release) || 0) > (releaseRank.get(strongest) || 0)) {
      strongest = release
    }
  }

  return strongest
}

function analyzeBranchName(branchName) {
  const normalizedBranch = `${branchName || ''}`.trim().replace(/^refs\/heads\//, '')
  const [branchType = ''] = normalizedBranch.split('/').filter(Boolean)
  const normalizedType = branchType.toLowerCase()

  return {
    branch: normalizedBranch,
    branchType: normalizedType,
    release: branchReleaseTypes.get(normalizedType) || 'none',
  }
}

function bumpVersion(version, releaseType) {
  const match = `${version || ''}`.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)

  if (!match) {
    throw new Error(`Unsupported version format: "${version}"`)
  }

  const [, majorValue, minorValue, patchValue] = match
  const major = Number.parseInt(majorValue, 10)
  const minor = Number.parseInt(minorValue, 10)
  const patch = Number.parseInt(patchValue, 10)

  if (releaseType === 'major') {
    return `${major + 1}.0.0`
  }

  if (releaseType === 'minor') {
    return `${major}.${minor + 1}.0`
  }

  if (releaseType === 'patch') {
    return `${major}.${minor}.${patch + 1}`
  }

  throw new Error(`Unsupported release type: "${releaseType}"`)
}

export {
  analyzeBranchName,
  analyzeConventionalMessage,
  branchReleaseTypes,
  bumpVersion,
  highestRelease,
  normalizeSubjectLine,
  promotionBranches,
  supportedBranchTypes,
}
