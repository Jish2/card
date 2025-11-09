# ca.rd

Prerequisites:

- [Vercel CLI](https://vercel.com/docs/cli) installed globally

To develop locally:

```
npm install
vc dev
```

```
open http://localhost:3000
```

To build locally:

```
npm install
vc build
```

To deploy:

```
npm install
vc deploy
```

## Environment variables

Set the following environment variables for the preview branch automation:

- `GITHUB_REPO_OWNER`
- `GITHUB_REPO_NAME`
- `GITHUB_REPO_BASE_BRANCH` (optional, defaults to `main`)
- `GITHUB_REPO_PAT` (personal access token with `repo` scope)
- `GITHUB_COMMIT_AUTHOR_NAME` (optional)
- `GITHUB_COMMIT_AUTHOR_EMAIL` (optional)
- `GITHUB_PREVIEW_FILE_PATH` (optional, defaults to `index.html` at repo root)

### Preview branch endpoint

POST `/github/preview`

```json
{
  "fields": {
    "personFirst": "Patrick",
    "personLast": "Bateman",
    "title": "Vice President"
  },
  "commitMessage": "chore: personalize card"
}
```

The server will:

- Merge the provided field values into the preview template
- Create a new branch derived from `GITHUB_REPO_BASE_BRANCH`
- Remove `README.md` on that branch (if present)
- Commit the updated `index.html` using `GITHUB_REPO_PAT`
- Respond with the `branch` name, the GitHub `branchUrl`, a `vercelImportUrl`, and the sanitized `appliedFields`
