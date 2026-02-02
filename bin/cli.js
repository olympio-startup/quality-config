#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIGS_DIR = path.join(__dirname, '..', 'configs');
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const args = process.argv.slice(2);
const command = args[0];

const STACKS = {
  'react':          { lang: 'js', label: 'React (Vite/CRA)' },
  'nextjs':         { lang: 'js', label: 'Next.js' },
  'node':           { lang: 'js', label: 'Node.js (Express/Fastify)' },
  'react-native':   { lang: 'js', label: 'React Native' },
  'python-django':  { lang: 'py', label: 'Python (Django)' },
  'python-fastapi': { lang: 'py', label: 'Python (FastAPI)' },
};

// ─── Helpers ────────────────────────────────────────────────

function printHelp() {
  console.log(`
@olympio/quality-config - Unified quality & compliance tooling

Usage:
  quality-config init [options]     Setup quality configs in current project
  quality-config scan               Run SonarQube analysis via Docker
  quality-config hook install       Install pre-push git hook
  quality-config hook uninstall     Remove pre-push git hook
  quality-config doctor             Check if everything is configured correctly
  quality-config report             Generate LGPD compliance report
  quality-config update             Update configs to latest version

Options for init:
  --stack <stack>       Project stack (${Object.keys(STACKS).join(', ')})
  --project-key <key>   SonarQube project key
  --project-name <name> SonarQube project display name
  --skip-workflow       Don't generate GitHub Actions workflow
  --skip-docker         Don't generate docker-compose for SonarQube
  --skip-lgpd           Don't generate LGPD compliance rules

Examples:
  quality-config init --stack react --project-key my-app
  quality-config scan
  quality-config hook install
  quality-config doctor
`);
}

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        opts[key] = args[i + 1];
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyTemplate(templateName, destPath, replacements = {}) {
  let content = fs.readFileSync(path.join(TEMPLATES_DIR, templateName), 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  fs.writeFileSync(destPath, content, 'utf8');
}

function loadStackConfig(stack) {
  const configPath = path.join(CONFIGS_DIR, 'stacks', `${stack}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`Error: Unknown stack "${stack}". Supported: ${Object.keys(STACKS).join(', ')}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function getProjectKey(cwd) {
  const propsPath = path.join(cwd, 'sonar-project.properties');
  if (fs.existsSync(propsPath)) {
    const match = fs.readFileSync(propsPath, 'utf8').match(/sonar\.projectKey\s*=\s*(.+)/);
    if (match) return match[1].trim();
  }
  return path.basename(cwd);
}

function dockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sonarQubeRunning(cwd) {
  try {
    const result = execSync(
      `docker compose -f docker-compose.sonar.yml ps --status running 2>/dev/null`,
      { cwd, encoding: 'utf8' }
    );
    return result.includes('sonarqube');
  } catch {
    return false;
  }
}

function waitForSonarQube(cwd, maxRetries = 60) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = execSync(
        'curl -sf http://localhost:9000/api/system/status',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (result.includes('"UP"')) return true;
    } catch {}
    if (i % 6 === 0 && i > 0) {
      process.stdout.write(`  still waiting (${i * 5}s)...\n`);
    }
    spawnSync('sleep', ['5']);
  }
  return false;
}

function getSonarToken(cwd) {
  const tokenFile = path.join(cwd, '.sonar-token');
  if (fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  }

  // Try generating with default credentials
  try {
    const tokenName = `quality-config-${Date.now()}`;
    const result = execSync(
      `curl -sf -u admin:admin -X POST "http://localhost:9000/api/user_tokens/generate" -d "name=${tokenName}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const parsed = JSON.parse(result);
    if (parsed.token) {
      fs.writeFileSync(tokenFile, parsed.token, 'utf8');
      return parsed.token;
    }
  } catch {}

  return null;
}

// ─── Commands ───────────────────────────────────────────────

function cmdInit(args) {
  const opts = parseArgs(args);
  const cwd = process.cwd();

  if (!opts.stack) {
    console.error('Error: --stack is required. Options: ' + Object.keys(STACKS).join(', '));
    process.exit(1);
  }

  if (!STACKS[opts.stack]) {
    console.error(`Error: Unknown stack "${opts.stack}". Options: ${Object.keys(STACKS).join(', ')}`);
    process.exit(1);
  }

  const stackConfig = loadStackConfig(opts.stack);

  console.log(`\nInitializing @olympio/quality-config`);
  console.log(`  Stack: ${STACKS[opts.stack].label}`);
  console.log(`  Project: ${opts.projectKey || path.basename(cwd)}`);
  console.log('');

  // sonar-project.properties
  const replacements = {
    PROJECT_KEY: opts.projectKey || path.basename(cwd),
    PROJECT_NAME: opts.projectName || path.basename(cwd),
    SOURCES: stackConfig.sonar.sources,
    TESTS: stackConfig.sonar.tests || '',
    TEST_INCLUSIONS: stackConfig.sonar.testInclusions || '',
    EXCLUSIONS: stackConfig.sonar.exclusions,
    SOURCE_ENCODING: 'UTF-8',
    EXTRA_PROPERTIES: stackConfig.sonar.extraProperties || '',
  };
  copyTemplate('sonar-project.properties.tpl', path.join(cwd, 'sonar-project.properties'), replacements);
  console.log('  [created] sonar-project.properties');

  // docker-compose
  if (!opts.skipDocker) {
    fs.copyFileSync(
      path.join(CONFIGS_DIR, 'docker-compose.sonar.yml'),
      path.join(cwd, 'docker-compose.sonar.yml')
    );
    console.log('  [created] docker-compose.sonar.yml');
  }

  // GitHub Actions workflow
  if (!opts.skipWorkflow) {
    const tpl = stackConfig.lang === 'py' ? 'sonarqube-python.yml.tpl' : 'sonarqube-node.yml.tpl';
    ensureDir(path.join(cwd, '.github', 'workflows'));
    copyTemplate(tpl, path.join(cwd, '.github', 'workflows', 'sonarqube.yml'), {
      NODE_VERSION: stackConfig.nodeVersion || '18',
    });
    console.log('  [created] .github/workflows/sonarqube.yml');
  }

  // LGPD rules
  if (!opts.skipLgpd) {
    const rulesFile = stackConfig.lang === 'py' ? 'lgpd-rules-python.json' : 'lgpd-rules-js.json';
    fs.copyFileSync(
      path.join(CONFIGS_DIR, 'lgpd', rulesFile),
      path.join(cwd, '.sonarqube-lgpd-rules.json')
    );
    console.log('  [created] .sonarqube-lgpd-rules.json');
  }

  // .gitignore
  const gitignoreEntries = '\n# Quality & SonarQube\n.scannerwork/\n.sonar-token\nreports/\n';
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const current = fs.readFileSync(gitignorePath, 'utf8');
    if (!current.includes('.scannerwork')) {
      fs.appendFileSync(gitignorePath, gitignoreEntries);
      console.log('  [updated] .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, gitignoreEntries);
    console.log('  [created] .gitignore');
  }

  console.log('\nDone! Next steps:');
  console.log('  1. npx quality-config hook install    (pre-push scan)');
  console.log('  2. npx quality-config scan            (manual scan)');
  console.log('  3. npx quality-config doctor           (verify setup)');
  console.log('');
}

function cmdScan() {
  const cwd = process.cwd();

  if (!fs.existsSync(path.join(cwd, 'sonar-project.properties'))) {
    console.error('Error: sonar-project.properties not found. Run "quality-config init" first.');
    process.exit(1);
  }

  if (!fs.existsSync(path.join(cwd, 'docker-compose.sonar.yml'))) {
    console.error('Error: docker-compose.sonar.yml not found. Run "quality-config init" first.');
    process.exit(1);
  }

  if (!dockerAvailable()) {
    console.error('Error: Docker is not running. Start Docker Desktop and try again.');
    process.exit(1);
  }

  console.log('\n@olympio/quality-config - SonarQube Scan\n');

  // Start SonarQube if not running
  if (sonarQubeRunning(cwd)) {
    console.log('  [ok] SonarQube already running');
  } else {
    console.log('  [..] Starting SonarQube...');
    execSync('docker compose -f docker-compose.sonar.yml up -d sonarqube', {
      cwd,
      stdio: 'inherit',
    });

    console.log('  [..] Waiting for SonarQube to be ready...');
    if (!waitForSonarQube(cwd)) {
      console.error('\n  [error] SonarQube did not start. Check: docker compose -f docker-compose.sonar.yml logs');
      process.exit(1);
    }
    console.log('  [ok] SonarQube is ready');
  }

  // Get or generate token
  const token = getSonarToken(cwd);
  if (!token) {
    console.error('\n  [error] Could not get SonarQube token.');
    console.error('  Open http://localhost:9000 (admin/admin), generate a token, and save to .sonar-token');
    process.exit(1);
  }

  // Run sonar-scanner via Docker
  console.log('  [..] Running scan...\n');
  const scanResult = spawnSync('docker', [
    'run', '--rm',
    '--network', 'host',
    '-e', `SONAR_HOST_URL=http://localhost:9000`,
    '-e', `SONAR_TOKEN=${token}`,
    '-v', `${cwd}:/usr/src`,
    '-w', '/usr/src',
    'sonarsource/sonar-scanner-cli:latest',
  ], { cwd, stdio: 'inherit' });

  if (scanResult.status !== 0) {
    console.error('\n  [error] Scan failed.');
    process.exit(1);
  }

  const projectKey = getProjectKey(cwd);
  console.log(`\n  [ok] Scan complete!`);
  console.log(`  Results: http://localhost:9000/dashboard?id=${projectKey}\n`);
}

function cmdHook(args) {
  const sub = args[0];
  const cwd = process.cwd();

  if (sub === 'install') {
    // Find npx path for the hook
    const hookContent = `#!/bin/sh
# @olympio/quality-config pre-push hook
echo ""
echo "Running SonarQube analysis before push..."
echo ""
npx quality-config scan
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "[blocked] Push blocked: SonarQube scan failed."
  echo "Skip with: git push --no-verify"
  exit 1
fi
`;
    const hooksDir = path.join(cwd, '.git', 'hooks');
    if (!fs.existsSync(hooksDir)) {
      console.error('Error: Not a git repository.');
      process.exit(1);
    }

    const hookPath = path.join(hooksDir, 'pre-push');
    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
    console.log('\n  [ok] pre-push hook installed');
    console.log('  Every push will run: npx quality-config scan');
    console.log('  Skip with: git push --no-verify\n');

  } else if (sub === 'uninstall') {
    const hookPath = path.join(cwd, '.git', 'hooks', 'pre-push');
    if (fs.existsSync(hookPath)) {
      fs.unlinkSync(hookPath);
      console.log('\n  [ok] pre-push hook removed\n');
    } else {
      console.log('\n  [info] No pre-push hook found\n');
    }

  } else {
    console.error('Usage: quality-config hook install|uninstall');
    process.exit(1);
  }
}

function cmdDoctor() {
  const cwd = process.cwd();
  let issues = 0;

  console.log('\nRunning quality-config doctor...\n');

  const checks = [
    { file: 'sonar-project.properties', label: 'SonarQube config' },
    { file: 'docker-compose.sonar.yml', label: 'Docker Compose (SonarQube)' },
    { file: '.github/workflows/sonarqube.yml', label: 'GitHub Actions workflow' },
    { file: '.sonarqube-lgpd-rules.json', label: 'LGPD rules' },
  ];

  for (const check of checks) {
    const exists = fs.existsSync(path.join(cwd, check.file));
    const icon = exists ? '[ok]' : '[missing]';
    console.log(`  ${icon} ${check.label} (${check.file})`);
    if (!exists) issues++;
  }

  // Check pre-push hook
  const hookPath = path.join(cwd, '.git', 'hooks', 'pre-push');
  if (fs.existsSync(hookPath)) {
    const content = fs.readFileSync(hookPath, 'utf8');
    if (content.includes('quality-config')) {
      console.log('  [ok] pre-push hook');
    } else {
      console.log('  [warn] pre-push hook exists but is not from quality-config');
    }
  } else {
    console.log('  [missing] pre-push hook (run: quality-config hook install)');
    issues++;
  }

  // Check Docker
  if (dockerAvailable()) {
    console.log('  [ok] Docker');
  } else {
    console.log('  [missing] Docker is not running');
    issues++;
  }

  // Check for hardcoded tokens
  const sonarProps = path.join(cwd, 'sonar-project.properties');
  if (fs.existsSync(sonarProps)) {
    const content = fs.readFileSync(sonarProps, 'utf8');
    if (content.match(/sonar\.(login|token)\s*=\s*\S+/)) {
      console.log('\n  [warn] sonar-project.properties contains a hardcoded token!');
      console.log('         Use SONAR_TOKEN environment variable instead.');
      issues++;
    }
  }

  console.log(`\n${issues === 0 ? 'All checks passed!' : `${issues} issue(s) found.`}\n`);
}

function cmdReport() {
  const cwd = process.cwd();
  const reportDir = path.join(cwd, 'reports', 'lgpd');
  ensureDir(reportDir);

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportFile = path.join(reportDir, `compliance_report_${dateStr}.md`);
  const projectName = getProjectKey(cwd);
  const displayDate = now.toLocaleDateString('pt-BR') + ' ' + now.toLocaleTimeString('pt-BR');

  const content = `# LGPD Compliance Report
**Date**: ${displayDate}
**Project**: ${projectName}

---

## 1. Executive Summary

This report provides an overview of LGPD compliance status for the project.

## 2. Compliance Checklist

### Legal Basis (Art. 7 LGPD)
- [ ] Documented consent
- [ ] Specific purpose defined
- [ ] Justified necessity
- [ ] Transparency implemented

### Security (Art. 46 LGPD)
- [ ] Encryption in transit (HTTPS)
- [ ] Encryption at rest
- [ ] Access control (RLS/RBAC)
- [ ] Audit logging
- [ ] Regular backups

### Data Subject Rights (Art. 18 LGPD)
- [ ] Data access implemented
- [ ] Data correction implemented
- [ ] Data deletion implemented
- [ ] Data portability implemented
- [ ] Consent revocation implemented

### Governance
- [ ] DPO designated
- [ ] Data inventory maintained
- [ ] Privacy policy updated
- [ ] Retention policies defined
- [ ] Incident response plan

## 3. Recommendations

### Immediate Actions
1. Review pending deletion requests
2. Verify consent status
3. Audit sensitive data access

### Medium-term Actions
1. Implement retention policy automation
2. Create compliance dashboard
3. Train team on LGPD

### Long-term Actions
1. ISO 27001 certification
2. External audit
3. Implement Privacy by Design

---

**Generated by**: @olympio/quality-config
`;

  fs.writeFileSync(reportFile, content, 'utf8');
  console.log(`\n  [ok] Report generated: ${path.relative(cwd, reportFile)}\n`);
}

function cmdUpdate() {
  const cwd = process.cwd();

  if (!fs.existsSync(path.join(cwd, 'sonar-project.properties'))) {
    console.error('Error: No quality-config found in this project. Run "quality-config init" first.');
    process.exit(1);
  }

  console.log('\nUpdating shared configs...\n');

  const dockerSrc = path.join(CONFIGS_DIR, 'docker-compose.sonar.yml');
  const dockerDest = path.join(cwd, 'docker-compose.sonar.yml');
  if (fs.existsSync(dockerDest)) {
    fs.copyFileSync(dockerSrc, dockerDest);
    console.log('  [updated] docker-compose.sonar.yml');
  }

  console.log('\nDone! sonar-project.properties was NOT changed (project-specific).\n');
}

// ─── Main ───────────────────────────────────────────────────

switch (command) {
  case 'init':
    cmdInit(args.slice(1));
    break;
  case 'scan':
    cmdScan();
    break;
  case 'hook':
    cmdHook(args.slice(1));
    break;
  case 'doctor':
    cmdDoctor();
    break;
  case 'report':
    cmdReport();
    break;
  case 'update':
    cmdUpdate();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
