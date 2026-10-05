export type GraphQLVariables = Record<string, unknown>

export type GitHubLabel = {
  name: string
  color: string
  description: string | null
}

export type GitHubIssue = {
  number: number
  title: string
  body: string | null
  milestone: { number: number } | null
  node_id: string
}

export type GitHubPullRequest = {
  number: number
  title: string
  body: string | null
  node_id: string
}

export type GitHubMilestone = {
  number: number
  title: string
  state: string
}

export type GitHubSearchIssueItem = {
  number: number
  pull_request?: Record<string, unknown>
}

type GitHubRestIssuesApi = {
  getLabel: (params: {
    owner: string
    repo: string
    name: string
  }) => Promise<{ data: GitHubLabel }>
  createLabel: (params: {
    owner: string
    repo: string
    name: string
    color: string
    description: string
  }) => Promise<{ data: GitHubLabel }>
  updateLabel: (params: {
    owner: string
    repo: string
    name: string
    color: string
    description: string
  }) => Promise<{ data: GitHubLabel }>
  addLabels: (params: {
    owner: string
    repo: string
    issue_number: number
    labels: string[]
  }) => Promise<{ data: GitHubLabel[] }>
  setLabels: (params: {
    owner: string
    repo: string
    issue_number: number
    labels: string[]
  }) => Promise<{ data: GitHubLabel[] }>
  update: (params: {
    owner: string
    repo: string
    issue_number: number
    milestone?: number
    body?: string
    title?: string
    assignees?: string[]
  }) => Promise<{ data: GitHubIssue }>
  create: (params: {
    owner: string
    repo: string
    title: string
    body: string
    labels: string[]
    milestone?: number
    assignees?: string[]
  }) => Promise<{ data: GitHubIssue }>
  get: (params: {
    owner: string
    repo: string
    issue_number: number
  }) => Promise<{ data: GitHubIssue }>
  getMilestone: (params: {
    owner: string
    repo: string
    milestone_number: number
  }) => Promise<{ data: GitHubMilestone }>
  listMilestones: (params: {
    owner: string
    repo: string
    state: 'all' | 'open' | 'closed'
    per_page: number
  }) => Promise<{ data: GitHubMilestone[] }>
}

type GitHubRestSearchApi = {
  issuesAndPullRequests: (params: {
    q: string
    per_page: number
  }) => Promise<{ data: { items: GitHubSearchIssueItem[] } }>
}

type GitHubRestPullsApi = {
  list: (params: {
    owner: string
    repo: string
    state: 'open' | 'closed' | 'all'
    head: string
    base: string
    per_page: number
  }) => Promise<{ data: GitHubPullRequest[] }>
  update: (params: {
    owner: string
    repo: string
    pull_number: number
    body?: string
    title?: string
  }) => Promise<{ data: GitHubPullRequest }>
  create: (params: {
    owner: string
    repo: string
    title: string
    head: string
    base: string
    body: string
    draft: boolean
  }) => Promise<{ data: GitHubPullRequest }>
}

type GitHubCommit = {
  author: { login: string } | null
  committer: { login: string } | null
}

type GitHubComparison = {
  commits: { commit: { message: string } }[]
  files?: {
    filename: string
    status: string
    additions: number
    deletions: number
    patch?: string
  }[]
}

type GitHubRestReposApi = {
  listCommits: (params: {
    owner: string
    repo: string
    sha: string
    per_page: number
  }) => Promise<{ data: GitHubCommit[] }>
  compareCommitsWithBasehead: (params: {
    owner: string
    repo: string
    basehead: string
  }) => Promise<{ data: GitHubComparison }>
}

type GitHubRestClient = {
  issues: GitHubRestIssuesApi
  search: GitHubRestSearchApi
  pulls: GitHubRestPullsApi
  repos: GitHubRestReposApi
}

export type GitHubClient = {
  rest: GitHubRestClient
  graphql: <T>(query: string, variables?: GraphQLVariables) => Promise<T>
}

export type WorkflowContext = {
  repo: {
    owner: string
    repo: string
  }
  ref: string
}

export type CoreClient = {
  info: (message: string) => void
  warning: (message: string) => void
  notice: (message: string) => void
}

export type SelectedTypeConfig = {
  prefix: string
  label: string
  priority: string
  color: string
}

export type AutoWorkItemsConfig = {
  skip: false
  owner: string
  repo: string
  branch: string
  base: string
  branchType: string
  marker: string
  selectedType: SelectedTypeConfig
  typeLabel: string
  priorityValue: string
  issueTitle: string
  issueBody: string
  prTitle: string
  issueLabels: string[]
  prLabels: string[]
  strictMetadata: boolean
  sizeValue: string
  estimateValue: string
  env: NodeJS.ProcessEnv
}

export type SkippedConfig = {
  skip: true
}

export type BuildConfigResult = AutoWorkItemsConfig | SkippedConfig
