# Issue Tracker

Backend: GitHub
<!-- One of: GitHub | <named backend, e.g. Jira, Linear>. GitHub (or no file) uses the built-in gh default –
     omit the Operation Table below. -->

## Label Role Mapping
<!-- Canonical role → the label this repo actually uses. Defaults equal the canonical names;
     change the right column only when your tracker uses different label text. -->

| Canonical role  | Repo label      |
|-----------------|-----------------|
| needs-triage    | needs-triage    |
| needs-info      | needs-info      |
| ready-for-agent | ready-for-agent |
| ready-for-human | ready-for-human |
| wontfix         | wontfix         |
| bug             | bug             |
| enhancement     | enhancement     |

## Notes
<!-- Backend-specific quirks: auth, project/board scoping, required fields, rate limits. -->

- **No git remote is configured yet** – the repository has no `origin` and no commits. Issue operations will fail until a GitHub remote exists (`git remote add origin <url>`) and `gh auth status` reports an authenticated account.
