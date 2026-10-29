// What every PR the check covers must have, whatever its kind, and the AUTO_*
// knobs both kinds read. The rules of each kind live in its own folder —
// work-pr/rules.mjs, release-pr/rules.mjs — and build on these; dangerfile.mjs
// picks one by PR_KIND. Pure — no GitHub calls — so the tests run them on plain
// objects. The title and commit FORMAT is commitlint's job (the steps before
// Danger); these rules cover what commitlint cannot see.

export const TITLE_PATTERN = /^(\w+)(?:\([^)]+\))?(!)?: \S/
const DEFAULT_MAX_CHANGED_LINES = 500

// The AUTO_* knobs the rules read (repo variables over config/actions.env).
export function prConfig(env) {
  const maxChangedLines = Number.parseInt(env.AUTO_MAX_CHANGED_LINES ?? '', 10)
  return {
    baseBranch: (env.AUTO_BASE_BRANCH || 'dev').trim(),
    releaseBranch: (env.AUTO_RELEASE_BRANCH || 'main').trim(),
    milestoneTitle: (env.AUTO_MILESTONE_TITLE || '').trim(),
    projectNumber: Number.parseInt(env.AUTO_PROJECT_NUMBER ?? '', 10) || 0,
    projectOwner: (env.AUTO_PROJECT_OWNER || '').trim(),
    maxChangedLines: maxChangedLines > 0 ? maxChangedLines : DEFAULT_MAX_CHANGED_LINES,
  }
}

export const code = value => `\`${value}\``

/**
 * What both PR kinds need: an assignee, the milestone and the board when the
 * repo sets them, and a description.
 *
 * @param pr             { assignees: string[], milestone: string | null, body }
 * @param projects       [{ owner, number }] the PR is on (read only when a board is set)
 * @param projectsError  why `projects` could not be read, if it could not
 * @param config         prConfig(), with projectOwner defaulted to the repo owner
 * @returns {string[]}   the fails
 */
export function checkTracking({ pr, projects = [], projectsError = '', config }) {
  const fails = []

  if (pr.assignees.length === 0) {
    fails.push('Assign the PR to whoever is responsible for it.')
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

  return fails
}
