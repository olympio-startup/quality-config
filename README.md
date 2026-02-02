# @olympio/quality-config

Unified quality, security and LGPD compliance tooling for multi-stack projects.

## Supported Stacks

| Stack | Key |
|---|---|
| React (Vite/CRA) | `react` |
| Next.js | `nextjs` |
| Node.js (Express/NestJS/Fastify) | `node` |
| React Native | `react-native` |
| Python (Django) | `python-django` |
| Python (FastAPI) | `python-fastapi` |

## Installation

```bash
npm install -g @olympio/quality-config
```

Or run without installing:

```bash
npx @olympio/quality-config init --stack react --project-key my-app
```

## Quick Start

```bash
# 1. Initialize in your project
quality-config init --stack nextjs --project-key my-app

# 2. Start local SonarQube
docker compose -f docker-compose.sonar.yml up -d

# 3. Verify setup
quality-config doctor
```

## Commands

### `quality-config init`

Generates all quality and compliance configs in the current project.

```bash
quality-config init --stack <stack> [options]
```

| Option | Description |
|---|---|
| `--stack <stack>` | Project stack (required) |
| `--project-key <key>` | SonarQube project key (defaults to folder name) |
| `--project-name <name>` | SonarQube display name (defaults to folder name) |
| `--skip-workflow` | Skip GitHub Actions workflow generation |
| `--skip-docker` | Skip docker-compose generation |
| `--skip-lgpd` | Skip LGPD compliance configs |

**Generated files:**

```
your-project/
├── sonar-project.properties        # SonarQube config (stack-specific)
├── docker-compose.sonar.yml        # Local SonarQube server
├── .sonarqube-lgpd-rules.json      # LGPD/GDPR compliance rules
├── .github/
│   └── workflows/
│       └── sonarqube.yml           # CI pipeline (scan + quality gate)
└── scripts/
    └── generate-lgpd-report.sh     # LGPD compliance report generator
```

### `quality-config doctor`

Checks if all quality configs are present and valid. Warns about hardcoded tokens and missing environment variables.

```bash
quality-config doctor
```

### `quality-config report`

Generates an LGPD compliance report in `reports/lgpd/`.

```bash
quality-config report
```

### `quality-config update`

Updates shared configs (docker-compose, scripts) to the latest version without overwriting project-specific settings like `sonar-project.properties`.

```bash
quality-config update
```

## CI/CD Setup

Add these secrets to your GitHub repository:

| Secret | Description |
|---|---|
| `SONAR_TOKEN` | SonarQube authentication token |
| `SONAR_HOST_URL` | SonarQube server URL (e.g. `https://sonar.yourcompany.com`) |

The generated workflow runs on every push to `main`/`develop` and on pull requests.

## LGPD Compliance

The package includes a curated set of SonarQube rules mapped to LGPD articles:

| Rule | LGPD Article |
|---|---|
| Hardcoded credentials | Art. 46 - Information security |
| Insecure cookies | Art. 46 - Information security |
| HTTP URLs (no HTTPS) | Art. 46 - Information security |
| SQL injection | Art. 46 - Information security |
| XSS vulnerabilities | Art. 46 - Information security |
| Sensitive data in logs | Art. 46 - Information security |
| Insecure CORS | Art. 46 - Information security |
| Weak cryptography | Art. 46 - Information security |

## Monorepo Usage

After running `init`, edit `sonar-project.properties` to point to your specific source directories:

```properties
sonar.sources=frontend/src,backend/src
sonar.tests=backend/test
sonar.exclusions=**/node_modules/**,**/dist/**,**/prisma/migrations/**
```

## License

MIT
