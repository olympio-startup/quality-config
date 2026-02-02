# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-01

### Added
- `scan` command: runs SonarQube analysis via Docker (auto-starts server, generates token, runs scanner)
- `hook install` / `hook uninstall` commands: manage git pre-push hook
- Docker health check on SonarQube container
- Docker check in `doctor` command
- Pre-push hook check in `doctor` command

### Changed
- `report` command now runs entirely from the package (no shell scripts copied to project)
- `init` no longer generates `scripts/` directory in consumer projects
- `init` next steps now point to `scan` and `hook install` commands

### Removed
- Shell scripts are no longer copied to consumer projects

## [1.0.0] - 2026-02-01

### Added
- CLI with `init`, `doctor`, `report` and `update` commands
- SonarQube configuration templates for 6 stacks: React, Next.js, Node.js, React Native, Python Django, Python FastAPI
- GitHub Actions workflow templates (Node.js and Python)
- Docker Compose for local SonarQube Community
- LGPD/GDPR compliance rules mapped to SonarQube (JS/TS and Python)
- Hardcoded token detection in `doctor` command
