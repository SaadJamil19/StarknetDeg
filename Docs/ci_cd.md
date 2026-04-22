# CI/CD Deployment

This project uses GitHub Actions to build the Docker image and deploy it to the production server.

## What Happens

When code is pushed to the `main` branch:

1. GitHub builds the Docker image from `Dockerfile`.
2. GitHub pushes the image to GitHub Container Registry, also called GHCR.
3. GitHub connects to the production server with SSH.
4. The server pulls the newest image.
5. Docker Compose restarts the full stack:
   - main Starknet indexer
   - Phase 4 workers
   - Phase 6 workers
   - L1 indexer
   - L1 matcher
   - Postgres stays attached to the same persistent volume

The deploy command used on the server is:

```bash
docker compose --profile workers --profile l1 pull && docker compose --profile workers --profile l1 up -d
```

Those profile names match `docker-compose.yml`.

## GitHub Secrets To Add

Open your GitHub repo, then go to:

`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

Add these secrets:

- `GHCR_TOKEN`
- `SERVER_IP`
- `SERVER_USER`
- `SSH_PRIVATE_KEY`
- `SERVER_SSH_HOST_KEY`

### `GHCR_TOKEN`

Create a GitHub Personal Access Token with package permissions.

For a classic token, use:

- `write:packages`
- `read:packages`

The same token is used by GitHub Actions to push the image and by the server to pull it.

By default, the workflow logs in to GHCR as the repository owner. If the token belongs to a separate deploy or machine account, set the optional `GHCR_USER` repository variable described below.

### `SERVER_IP`

The production server IP address.

Example:

```text
203.0.113.10
```

### `SERVER_USER`

The Linux user used for deployment.

Example:

```text
ubuntu
```

That user must be able to run Docker commands.

### `SSH_PRIVATE_KEY`

Use a deploy-only SSH key, not your personal key.

Generate one:

```bash
ssh-keygen -t ed25519 -C "starknetdeg-github-deploy" -f starknetdeg_github_deploy
```

Put the public key on the server:

```bash
cat starknetdeg_github_deploy.pub >> ~/.ssh/authorized_keys
```

Paste the private key file content into the GitHub secret:

```bash
cat starknetdeg_github_deploy
```

### `SERVER_SSH_HOST_KEY`

This is required so GitHub verifies it is connecting to the real server.

Do not use `StrictHostKeyChecking=no` in production.

Safest method: copy the host public key from the server console, cloud provider console, or another trusted access path.

```bash
printf '203.0.113.10 '
cat /etc/ssh/ssh_host_ed25519_key.pub
```

Replace `203.0.113.10` with the exact same value used in `SERVER_IP`.

The secret should look like:

```text
203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
```

If the server does not have an Ed25519 host key, use its RSA or ECDSA host public key instead.

## Optional GitHub Variables

Repository variables are added here:

`Settings` -> `Secrets and variables` -> `Actions` -> `Variables` -> `New repository variable`

### `GHCR_USER`

Only set this if `GHCR_TOKEN` belongs to a deploy or machine account instead of the repository owner.

Value example:

```text
starknetdeg-deploy-bot
```

### `SERVER_APP_DIR`

If the repo is not located at `~/StarknetDeg` on the server, add this variable.

Name:

```text
SERVER_APP_DIR
```

Value example:

```text
/opt/StarknetDeg
```

This is not a secret because it is only a filesystem path.

## Server Setup Required Once

On the server:

1. Install Docker and Docker Compose.
2. Clone this repository.
3. Create `.env` from `.env.example`.
4. Fill production RPC and DB values.
5. Confirm Docker works:

```bash
docker compose --profile workers --profile l1 up -d
```

After that, GitHub Actions can deploy automatically.

## How To Check Deployment

In GitHub:

1. Open the repository.
2. Click `Actions`.
3. Open the latest `Build and Deploy` workflow run.
4. Check both jobs:
   - `Build Docker Image`
   - `Deploy to Production`

Green means success.

Red means failure. Open the failed job and read the last error lines.

Common failure reasons:

- `GHCR_TOKEN` is missing or does not have package permissions.
- SSH key is wrong.
- `SERVER_SSH_HOST_KEY` does not match the real server host key.
- The server does not have Docker installed.
- The server repo path is wrong.
- `.env` is missing on the server.

On the server, check running containers:

```bash
docker compose --profile workers --profile l1 ps
```

Check logs:

```bash
docker compose --profile workers --profile l1 logs -f
```
