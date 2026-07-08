---
tracker:
  github:
    repository: alextis59/pdf-2-llm
    api_key: $GITHUB_TOKEN
    base_branch: main
    branch_prefix: symphony
    pull_request_workflow: true
workspace:
  root: workspaces
agent:
  issue_triggers: []
  max_concurrent_agents: 1
  max_turns_per_issue: 3
codex:
  app_server: codex app-server
  model: gpt-5.5
  effort: high
  sandbox: workspace-write
  approval_policy: never
  approvals_reviewer: auto_review
  service_name: symphony
polling:
  interval_ms: 30000
server:
  host: 127.0.0.1
---
You are working on issue {{ issue.identifier }} in alextis59/pdf-2-llm.

Title: {{ issue.title }}
State: {{ issue.state }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% endif %}

Follow the repository AGENTS.md instructions. Work only in the prepared workspace, complete the issue end-to-end unless blocked, validate your changes, then follow the appended Symphony GitHub work cycle instructions.
