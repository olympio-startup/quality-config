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
  quality-config export              Export SonarQube report as HTML (to share with clients)
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
  if (process.env.SONAR_TOKEN && String(process.env.SONAR_TOKEN).trim()) {
    return String(process.env.SONAR_TOKEN).trim();
  }

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

function sonarApiFetch(endpoint, token, sonarUrl = 'http://localhost:9000') {
  try {
    // SonarQube tokens are typically used via Basic Auth: token as username, empty password.
    // (Bearer is not consistently supported across SonarQube versions/setups.)
    const result = execSync(
      `curl -sf -u "${token}:" "${sonarUrl}${endpoint}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function sonarApiFetchPaged({ endpoint, token, sonarUrl, itemsKey, pageSize = 500, maxItems = 5000 }) {
  const allItems = [];
  let page = 1;
  let total = null;
  let lastResponse = null;

  while (allItems.length < maxItems) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const response = sonarApiFetch(`${endpoint}${sep}p=${page}&ps=${pageSize}`, token, sonarUrl);
    if (!response) break;

    lastResponse = response;
    const items = Array.isArray(response[itemsKey]) ? response[itemsKey] : [];
    allItems.push(...items);

    total = typeof response.paging?.total === 'number' ? response.paging.total : total;
    if (items.length === 0) break;
    if (typeof total === 'number' && allItems.length >= total) break;

    page += 1;
  }

  if (!lastResponse) return null;
  return {
    ...lastResponse,
    [itemsKey]: allItems.slice(0, maxItems),
    paging: {
      ...lastResponse.paging,
      total: typeof total === 'number' ? total : allItems.length,
    },
  };
}

function severityBadge(severity) {
  const colors = {
    BLOCKER: '#d4333f', CRITICAL: '#d4333f', MAJOR: '#ed7d20',
    MINOR: '#eabe06', INFO: '#2d9fd9',
  };
  const color = colors[severity] || '#888';
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">${severity}</span>`;
}

function typeBadge(type) {
  const labels = {
    BUG: 'Bug', VULNERABILITY: 'Vulnerability', CODE_SMELL: 'Code Smell',
    SECURITY_HOTSPOT: 'Hotspot',
  };
  return labels[type] || type;
}

function qualityGateIcon(status) {
  if (status === 'OK') return '<span style="color:#2ea44f;font-size:24px">PASSED</span>';
  if (status === 'ERROR') return '<span style="color:#d4333f;font-size:24px">FAILED</span>';
  return `<span style="color:#888;font-size:24px">${status}</span>`;
}

async function cmdExport() {
  const cwd = process.cwd();
  const projectKey = getProjectKey(cwd);
  const token = getSonarToken(cwd);
  const sonarUrl = process.env.SONAR_HOST_URL || 'http://localhost:9000';

  if (!token) {
    console.error('Error: No SonarQube token found. Run "quality-config scan" first or save token to .sonar-token');
    process.exit(1);
  }

  console.log('\n@olympio/quality-config - Full Project Report\n');
  console.log(`  Project: ${projectKey}`);
  console.log(`  Server: ${sonarUrl}\n`);

  // ── 1. SonarQube data ──
  console.log('  [..] Fetching SonarQube data...');
  const qualityGate = sonarApiFetch(`/api/qualitygates/project_status?projectKey=${projectKey}`, token, sonarUrl);
  const measures = sonarApiFetch(
    `/api/measures/component?component=${projectKey}&metricKeys=bugs,vulnerabilities,code_smells,security_hotspots,coverage,duplicated_lines_density,ncloc,sqale_index,sqale_debt_ratio,security_rating,reliability_rating,sqale_rating,alert_status,complexity,cognitive_complexity,duplicated_blocks,duplicated_files,files,functions,classes,statements`,
    token, sonarUrl
  );
  const issues = sonarApiFetchPaged({
    endpoint: `/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&s=SEVERITY&asc=false&statuses=OPEN,CONFIRMED,REOPENED`,
    token,
    sonarUrl,
    itemsKey: 'issues',
    pageSize: 500,
    maxItems: 5000,
  });
  const hotspots = sonarApiFetchPaged({
    endpoint: `/api/hotspots/search?projectKey=${encodeURIComponent(projectKey)}`,
    token,
    sonarUrl,
    itemsKey: 'hotspots',
    pageSize: 500,
    maxItems: 5000,
  });

  if (!measures || !measures.component) {
    console.error('  [error] Could not fetch project data. Is SonarQube running?');
    process.exit(1);
  }

  const metricsMap = {};
  for (const m of measures.component.measures || []) {
    metricsMap[m.metric] = m.value;
  }

  // ── 2. Dependency audit (npm) ──
  console.log('  [..] Analyzing dependencies...');
  let npmAudit = null;
  let npmOutdated = null;
  let pkgJson = null;
  let pkgLockExists = false;

  // Find package.json (root or subdirectories)
  const pkgPaths = [
    path.join(cwd, 'package.json'),
    path.join(cwd, 'frontend', 'package.json'),
    path.join(cwd, 'backend', 'package.json'),
  ];
  const foundPkgs = pkgPaths.filter(p => fs.existsSync(p));

  const allAuditVulns = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 };
  const allDeps = { dependencies: 0, devDependencies: 0 };
  let outdatedList = [];

  for (const pkgPath of foundPkgs) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkgJson) pkgJson = pkg;
      allDeps.dependencies += Object.keys(pkg.dependencies || {}).length;
      allDeps.devDependencies += Object.keys(pkg.devDependencies || {}).length;
    } catch {}

    const pkgDir = path.dirname(pkgPath);
    if (fs.existsSync(path.join(pkgDir, 'package-lock.json'))) {
      try {
        const auditResult = execSync('npm audit --json 2>/dev/null || true', {
          cwd: pkgDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
        });
        const audit = JSON.parse(auditResult);
        const vulns = audit.metadata?.vulnerabilities || audit.vulnerabilities || {};
        for (const sev of ['critical', 'high', 'moderate', 'low', 'info']) {
          allAuditVulns[sev] += (typeof vulns[sev] === 'number' ? vulns[sev] : 0);
        }
        if (typeof vulns.total === 'number') {
          allAuditVulns.total += vulns.total;
        } else {
          allAuditVulns.total += ['critical', 'high', 'moderate', 'low', 'info'].reduce((sum, sev) => {
            return sum + (typeof vulns[sev] === 'number' ? vulns[sev] : 0);
          }, 0);
        }
      } catch {}

      try {
        const outdatedResult = execSync('npm outdated --json 2>/dev/null || true', {
          cwd: pkgDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
        });
        const outdated = JSON.parse(outdatedResult || '{}');
        for (const [name, info] of Object.entries(outdated)) {
          outdatedList.push({ name, current: info.current, wanted: info.wanted, latest: info.latest, location: path.relative(cwd, pkgDir) || '.' });
        }
      } catch {}
    }
  }

  // ── 3. Git info ──
  console.log('  [..] Reading git history...');
  let gitBranch = '', gitCommitCount = '', gitLastCommit = '', gitContributors = [];
  try {
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
    gitCommitCount = execSync('git rev-list --count HEAD', { cwd, encoding: 'utf8' }).trim();
    gitLastCommit = execSync('git log -1 --format="%h - %s (%ar)"', { cwd, encoding: 'utf8' }).trim();
    const contribRaw = execSync('git shortlog -sn --no-merges HEAD | head -10', { cwd, encoding: 'utf8' }).trim();
    gitContributors = contribRaw.split('\n').map(l => {
      const match = l.trim().match(/^(\d+)\s+(.+)$/);
      return match ? { commits: match[1], name: match[2] } : null;
    }).filter(Boolean);
  } catch {}

  // ── 4. LGPD rules check ──
  console.log('  [..] Evaluating LGPD compliance...');
  let lgpdRules = [];
  const lgpdRulesPath = path.join(cwd, '.sonarqube-lgpd-rules.json');
  if (fs.existsSync(lgpdRulesPath)) {
    try {
      const lgpdData = JSON.parse(fs.readFileSync(lgpdRulesPath, 'utf8'));
      lgpdRules = lgpdData.rules || [];
    } catch {}
  }

  // Cross-reference LGPD rules with actual issues
  const issueList = issues?.issues || [];
  const lgpdIssues = [];
  const lgpdRuleKeysExact = new Set(lgpdRules.map(r => r.key).filter(Boolean));
  const lgpdRuleSuffixes = new Set(lgpdRules.map(r => (r.key || '').split(':').pop()).filter(Boolean));
  for (const issue of issueList) {
    const issueRule = issue.rule || '';
    const suffix = issueRule.split(':').pop();
    if (lgpdRuleKeysExact.has(issueRule) || lgpdRuleSuffixes.has(suffix)) {
      const rule = lgpdRules.find(r => r.key === issueRule) || lgpdRules.find(r => (r.key || '').split(':').pop() === suffix);
      lgpdIssues.push({ ...issue, lgpdArticle: rule?.lgpd_article, lgpdName: rule?.name });
    }
  }

  // LGPD compliance score
  function issueRuleRepo(issue) {
    const rule = issue.rule || '';
    return rule.includes(':') ? rule.split(':')[0] : rule;
  }
  function issueRuleSuffix(issue) {
    const rule = issue.rule || '';
    return rule.includes(':') ? rule.split(':').pop() : rule;
  }
  function hasAnyRuleSuffix(suffixes) {
    const set = new Set(suffixes);
    return issueList.some(i => set.has(issueRuleSuffix(i)));
  }
  function hasSecretsIssues() {
    return issueList.some(i => issueRuleRepo(i) === 'secrets');
  }
  const lgpdChecks = [
    { label: 'No hardcoded credentials / secrets', check: !(hasAnyRuleSuffix(['S2068']) || hasSecretsIssues()) },
    { label: 'HTTPS enforced', check: !hasAnyRuleSuffix(['S5332']) },
    { label: 'Secure cookies', check: !hasAnyRuleSuffix(['S2255']) },
    { label: 'No sensitive data in logs', check: !hasAnyRuleSuffix(['S4507']) },
    { label: 'SQL injection protected', check: !hasAnyRuleSuffix(['S2077', 'S3649']) },
    { label: 'XSS protected', check: !hasAnyRuleSuffix(['S5131']) },
    { label: 'CORS configured', check: !hasAnyRuleSuffix(['S5122']) },
    { label: 'Encrypted storage', check: !hasAnyRuleSuffix(['S5443']) },
    { label: 'Secure random generators', check: !hasAnyRuleSuffix(['S2245']) },
    { label: 'No hardcoded IPs', check: !hasAnyRuleSuffix(['S1313']) },
    { label: 'No dependency vulnerabilities (critical)', check: allAuditVulns.critical === 0 },
    { label: 'No dependency vulnerabilities (high)', check: allAuditVulns.high === 0 },
  ];
  const lgpdPassed = lgpdChecks.filter(c => c.check).length;
  const lgpdScore = Math.round((lgpdPassed / lgpdChecks.length) * 100);

  // ── 5. Build HTML ──
  console.log('  [..] Generating report...\n');

  const now = new Date();
  const displayDate = now.toLocaleDateString('pt-BR') + ' ' + now.toLocaleTimeString('pt-BR');
  const projectName = measures.component.name || projectKey;

  const ratingLabels = { '1.0': 'A', '2.0': 'B', '3.0': 'C', '4.0': 'D', '5.0': 'E' };
  const ratingColors = { 'A': '#2ea44f', 'B': '#84bb4c', 'C': '#eabe06', 'D': '#ed7d20', 'E': '#d4333f' };
  function ratingBadge(value) {
    const letter = ratingLabels[value] || value || '-';
    const color = ratingColors[letter] || '#888';
    return `<span style="background:${color};color:#fff;padding:4px 12px;border-radius:4px;font-size:18px;font-weight:700">${letter}</span>`;
  }
  function scoreBadge(score) {
    const color = score >= 80 ? '#2ea44f' : score >= 60 ? '#eabe06' : score >= 40 ? '#ed7d20' : '#d4333f';
    return `<span style="background:${color};color:#fff;padding:8px 20px;border-radius:8px;font-size:28px;font-weight:700">${score}%</span>`;
  }

  const gateStatus = qualityGate?.projectStatus?.status || 'UNKNOWN';
  const gateConditions = qualityGate?.projectStatus?.conditions || [];
  const hotspotList = hotspots?.hotspots || [];

  // Health score (weighted)
  const reliabilityScore = { '1.0': 100, '2.0': 75, '3.0': 50, '4.0': 25, '5.0': 0 };
  const healthWeights = {
    reliability: 20, security: 25, maintainability: 15, lgpd: 25, dependencies: 15,
  };
  const depScore = allAuditVulns.critical > 0 ? 0 : allAuditVulns.high > 0 ? 30 : allAuditVulns.moderate > 0 ? 60 : 100;
  const healthScore = Math.round(
    (reliabilityScore[metricsMap.reliability_rating] || 50) * (healthWeights.reliability / 100) +
    (reliabilityScore[metricsMap.security_rating] || 50) * (healthWeights.security / 100) +
    (reliabilityScore[metricsMap.sqale_rating] || 50) * (healthWeights.maintainability / 100) +
    lgpdScore * (healthWeights.lgpd / 100) +
    depScore * (healthWeights.dependencies / 100)
  );

  // Technical debt
  const debtMinutes = parseInt(metricsMap.sqale_index || '0');
  const debtDays = Math.round(debtMinutes / 480 * 10) / 10;
  const debtHours = Math.round(debtMinutes / 60 * 10) / 10;

  // Issues grouped
  const issuesByType = {};
  const issuesBySeverity = {};
  for (const issue of issueList) {
    const t = issue.type || 'UNKNOWN';
    const s = issue.severity || 'UNKNOWN';
    issuesByType[t] = (issuesByType[t] || 0) + 1;
    issuesBySeverity[s] = (issuesBySeverity[s] || 0) + 1;
  }

  // Top files by issues
  const issuesByFile = {};
  for (const issue of issueList) {
    const file = (issue.component || '').replace(`${projectKey}:`, '');
    issuesByFile[file] = (issuesByFile[file] || 0) + 1;
  }
  const topFiles = Object.entries(issuesByFile).sort((a, b) => b[1] - a[1]).slice(0, 15);

  // Hotspot categories
  const hotspotsByCategory = {};
  for (const h of hotspotList) {
    const cat = h.securityCategory || 'other';
    hotspotsByCategory[cat] = (hotspotsByCategory[cat] || 0) + 1;
  }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Project Report - ${escapeHtml(projectName)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; background: #f5f5f5; line-height: 1.5; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: #fff; padding: 48px 40px; border-radius: 16px; margin-bottom: 24px; }
  .header h1 { font-size: 32px; margin-bottom: 4px; }
  .header .subtitle { font-size: 16px; opacity: 0.7; margin-bottom: 16px; }
  .header-meta { display: flex; gap: 32px; flex-wrap: wrap; font-size: 13px; opacity: 0.8; }
  .card { background: #fff; border-radius: 12px; padding: 28px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card h2 { font-size: 18px; margin-bottom: 16px; color: #1a1a2e; border-bottom: 2px solid #f0f0f0; padding-bottom: 8px; }
  .card h3 { font-size: 15px; margin: 16px 0 8px; color: #444; }
  .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; }
  .metric { text-align: center; padding: 20px 12px; background: #fafafa; border-radius: 8px; }
  .metric .value { font-size: 28px; font-weight: 700; color: #1a1a2e; }
  .metric .label { font-size: 12px; color: #666; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f8f8f8; text-align: left; padding: 10px 12px; font-weight: 600; border-bottom: 2px solid #eee; }
  td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:hover { background: #fafafa; }
  .gate-banner { padding: 24px; border-radius: 8px; text-align: center; margin-bottom: 16px; }
  .gate-passed { background: #e6f9e6; border: 1px solid #2ea44f; }
  .gate-failed { background: #fde8e8; border: 1px solid #d4333f; }
  .flex-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .flex-row > * { flex: 1; min-width: 300px; }
  .bar { height: 24px; border-radius: 4px; display: flex; overflow: hidden; margin: 8px 0; }
  .bar > div { height: 100%; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 11px; font-weight: 600; }
  .check-list { list-style: none; }
  .check-list li { padding: 6px 0; border-bottom: 1px solid #f5f5f5; font-size: 14px; }
  .check-list li::before { margin-right: 8px; font-weight: bold; }
  .check-pass::before { content: "PASS"; color: #2ea44f; }
  .check-fail::before { content: "FAIL"; color: #d4333f; }
  .summary-bar { display: flex; gap: 24px; flex-wrap: wrap; justify-content: center; margin: 16px 0; }
  .summary-item { text-align: center; }
  .summary-item .num { font-size: 24px; font-weight: 700; }
  .summary-item .lbl { font-size: 12px; color: #666; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin: 1px; }
  .progress-ring { display: inline-block; position: relative; width: 120px; height: 120px; }
  .footer { text-align: center; padding: 32px 24px; color: #999; font-size: 12px; }
  .toc { column-count: 2; column-gap: 24px; font-size: 14px; }
  .toc a { color: #0f3460; text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  .toc li { padding: 3px 0; }
  .vuln-critical { background: #d4333f; color: #fff; }
  .vuln-high { background: #ed7d20; color: #fff; }
  .vuln-moderate { background: #eabe06; color: #333; }
  .vuln-low { background: #2d9fd9; color: #fff; }
  @media print {
    body { background: #fff; font-size: 12px; }
    .container { padding: 0; }
    .card { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; }
    .header { break-after: avoid; }
  }
</style>
</head>
<body>
<div class="container">

<!-- ═══ HEADER ═══ -->
<div class="header">
  <h1>${escapeHtml(projectName)}</h1>
  <div class="subtitle">Project Quality, Security & Compliance Report</div>
  <div class="header-meta">
    <div>Date: ${displayDate}</div>
    <div>Lines of Code: ${Number(metricsMap.ncloc || 0).toLocaleString('pt-BR')}</div>
    <div>Branch: ${escapeHtml(gitBranch)}</div>
    <div>Commits: ${gitCommitCount}</div>
  </div>
</div>

<!-- ═══ TABLE OF CONTENTS ═══ -->
<div class="card">
  <h2>Table of Contents</h2>
  <ol class="toc">
    <li><a href="#health">Project Health Score</a></li>
    <li><a href="#gate">Quality Gate</a></li>
    <li><a href="#overview">Code Quality Overview</a></li>
    <li><a href="#security">Security Analysis</a></li>
    <li><a href="#lgpd">LGPD Compliance</a></li>
    <li><a href="#deps">Dependencies & Vulnerabilities</a></li>
    <li><a href="#architecture">Code Architecture</a></li>
    <li><a href="#debt">Technical Debt</a></li>
    <li><a href="#hotfiles">Critical Files</a></li>
    <li><a href="#issues">Detailed Issues</a></li>
    <li><a href="#git">Repository Activity</a></li>
    <li><a href="#recommendations">Recommendations</a></li>
  </ol>
</div>

<!-- ═══ 1. HEALTH SCORE ═══ -->
<div class="card" id="health">
  <h2>1. Project Health Score</h2>
  <div style="text-align:center;padding:24px 0">
    ${scoreBadge(healthScore)}
    <div style="margin-top:12px;font-size:14px;color:#666">
      Weighted score: Reliability (${healthWeights.reliability}%) + Security (${healthWeights.security}%) + Maintainability (${healthWeights.maintainability}%) + LGPD (${healthWeights.lgpd}%) + Dependencies (${healthWeights.dependencies}%)
    </div>
  </div>
  <div class="metrics-grid" style="margin-top:16px">
    <div class="metric">
      <div class="value">${ratingBadge(metricsMap.reliability_rating)}</div>
      <div class="label">Reliability</div>
    </div>
    <div class="metric">
      <div class="value">${ratingBadge(metricsMap.security_rating)}</div>
      <div class="label">Security</div>
    </div>
    <div class="metric">
      <div class="value">${ratingBadge(metricsMap.sqale_rating)}</div>
      <div class="label">Maintainability</div>
    </div>
    <div class="metric">
      <div class="value">${scoreBadge(lgpdScore).replace('font-size:28px', 'font-size:18px')}</div>
      <div class="label">LGPD Compliance</div>
    </div>
    <div class="metric">
      <div class="value">${scoreBadge(depScore).replace('font-size:28px', 'font-size:18px')}</div>
      <div class="label">Dependencies</div>
    </div>
  </div>
</div>

<!-- ═══ 2. QUALITY GATE ═══ -->
<div class="card" id="gate">
  <h2>2. Quality Gate</h2>
  <div class="gate-banner ${gateStatus === 'OK' ? 'gate-passed' : 'gate-failed'}">
    <div style="font-size:14px;font-weight:600;margin-bottom:8px">QUALITY GATE</div>
    ${qualityGateIcon(gateStatus)}
  </div>
  ${gateConditions.length > 0 ? `
  <table>
    <thead><tr><th></th><th>Metric</th><th>Value</th><th>Threshold</th><th>Status</th></tr></thead>
    <tbody>${gateConditions.map(c => {
      const icon = c.status === 'OK' ? '&#10003;' : '&#10007;';
      const color = c.status === 'OK' ? '#2ea44f' : '#d4333f';
      return `<tr><td style="color:${color};font-weight:bold">${icon}</td><td>${escapeHtml(c.metricKey)}</td><td>${c.actualValue || '-'}</td><td>${c.comparator || ''} ${c.errorThreshold || ''}</td><td style="color:${color};font-weight:bold">${c.status}</td></tr>`;
    }).join('')}</tbody>
  </table>` : ''}
</div>

<!-- ═══ 3. OVERVIEW ═══ -->
<div class="card" id="overview">
  <h2>3. Code Quality Overview</h2>
  <div class="metrics-grid">
    <div class="metric"><div class="value">${metricsMap.bugs || '0'}</div><div class="label">Bugs</div></div>
    <div class="metric"><div class="value">${metricsMap.vulnerabilities || '0'}</div><div class="label">Vulnerabilities</div></div>
    <div class="metric"><div class="value">${metricsMap.code_smells || '0'}</div><div class="label">Code Smells</div></div>
    <div class="metric"><div class="value">${metricsMap.security_hotspots || '0'}</div><div class="label">Security Hotspots</div></div>
    <div class="metric"><div class="value">${metricsMap.coverage ? metricsMap.coverage + '%' : 'N/A'}</div><div class="label">Test Coverage</div></div>
    <div class="metric"><div class="value">${metricsMap.duplicated_lines_density ? metricsMap.duplicated_lines_density + '%' : 'N/A'}</div><div class="label">Duplications</div></div>
  </div>

  <h3>Issues by Severity</h3>
  <div class="bar">
    ${['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'].map(sev => {
      const count = issuesBySeverity[sev] || 0;
      if (count === 0) return '';
      const colors = { BLOCKER: '#d4333f', CRITICAL: '#e05555', MAJOR: '#ed7d20', MINOR: '#eabe06', INFO: '#2d9fd9' };
      const pct = Math.max((count / issueList.length) * 100, 5);
      return `<div style="background:${colors[sev]};width:${pct}%">${sev} ${count}</div>`;
    }).join('')}
  </div>

  <h3>Issues by Type</h3>
  <div class="summary-bar">
    ${Object.entries(issuesByType).map(([type, count]) =>
      `<div class="summary-item"><div class="num">${count}</div><div class="lbl">${typeBadge(type)}</div></div>`
    ).join('')}
  </div>
</div>

<!-- ═══ 4. SECURITY ═══ -->
<div class="card" id="security">
  <h2>4. Security Analysis</h2>
  <div class="flex-row">
    <div>
      <h3>Security Hotspots by Category</h3>
      ${Object.keys(hotspotsByCategory).length > 0 ? `
      <table>
        <thead><tr><th>Category</th><th>Count</th></tr></thead>
        <tbody>${Object.entries(hotspotsByCategory).sort((a,b) => b[1]-a[1]).map(([cat, count]) =>
          `<tr><td>${escapeHtml(cat)}</td><td><strong>${count}</strong></td></tr>`
        ).join('')}</tbody>
      </table>` : '<p style="color:#666">No security hotspots found.</p>'}
    </div>
    <div>
      <h3>Vulnerability Summary</h3>
      <div class="metrics-grid">
        <div class="metric"><div class="value">${metricsMap.vulnerabilities || '0'}</div><div class="label">Code Vulnerabilities</div></div>
        <div class="metric"><div class="value">${allAuditVulns.total}</div><div class="label">Dependency Vulnerabilities</div></div>
      </div>
    </div>
  </div>
  ${hotspotList.length > 0 ? `
  <h3>Security Hotspots Detail</h3>
  <table>
    <thead><tr><th>Risk</th><th>Category</th><th>Description</th><th>File</th><th>Status</th></tr></thead>
    <tbody>${hotspotList.map(h => {
      const file = (h.component || '').replace(`${projectKey}:`, '');
      return `<tr>
        <td>${severityBadge(h.vulnerabilityProbability || 'MEDIUM')}</td>
        <td>${escapeHtml(h.securityCategory || '')}</td>
        <td>${escapeHtml(h.message || '')}</td>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(file)}:${h.line || ''}</td>
        <td>${h.status || ''}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>` : ''}
</div>

<!-- ═══ 5. LGPD ═══ -->
<div class="card" id="lgpd">
  <h2>5. LGPD Compliance (Lei Geral de Prote&ccedil;&atilde;o de Dados)</h2>
  <div style="text-align:center;padding:16px 0">
    ${scoreBadge(lgpdScore)}
    <div style="margin-top:8px;font-size:13px;color:#666">${lgpdPassed}/${lgpdChecks.length} checks passed</div>
  </div>

  <h3>Automated Checks (Art. 46 - Security)</h3>
  <ul class="check-list">
    ${lgpdChecks.map(c => `<li class="${c.check ? 'check-pass' : 'check-fail'}">${escapeHtml(c.label)}</li>`).join('')}
  </ul>

  ${lgpdIssues.length > 0 ? `
  <h3>LGPD-Related Issues Found (${lgpdIssues.length})</h3>
  <table>
    <thead><tr><th>LGPD Article</th><th>Rule</th><th>Description</th><th>File</th></tr></thead>
    <tbody>${lgpdIssues.slice(0, 50).map(i => {
      const file = (i.component || '').replace(`${projectKey}:`, '');
      return `<tr>
        <td><strong>${escapeHtml(i.lgpdArticle || '')}</strong></td>
        <td>${escapeHtml(i.lgpdName || i.rule || '')}</td>
        <td>${escapeHtml(i.message || '')}</td>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(file)}:${i.line || ''}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>` : '<p style="color:#2ea44f;font-weight:600;margin-top:12px">No LGPD-related issues found in code analysis.</p>'}

  <h3 style="margin-top:20px">Manual Review Checklist</h3>
  <table>
    <thead><tr><th>Category</th><th>Requirement</th><th>LGPD Article</th></tr></thead>
    <tbody>
      <tr><td>Consent</td><td>Explicit consent collection implemented</td><td>Art. 7 - Legal basis</td></tr>
      <tr><td>Consent</td><td>Consent revocation mechanism available</td><td>Art. 8 - Consent requirements</td></tr>
      <tr><td>Data Rights</td><td>Data access endpoint for users</td><td>Art. 18 - Data subject rights</td></tr>
      <tr><td>Data Rights</td><td>Data deletion (right to be forgotten)</td><td>Art. 18 - Data subject rights</td></tr>
      <tr><td>Data Rights</td><td>Data portability export</td><td>Art. 18 - Data subject rights</td></tr>
      <tr><td>Governance</td><td>DPO (Data Protection Officer) designated</td><td>Art. 41 - DPO</td></tr>
      <tr><td>Governance</td><td>Data inventory maintained</td><td>Art. 37 - Records</td></tr>
      <tr><td>Governance</td><td>Incident response plan documented</td><td>Art. 48 - Incident notification</td></tr>
      <tr><td>Governance</td><td>Data retention policies defined</td><td>Art. 16 - Data elimination</td></tr>
      <tr><td>Privacy</td><td>Privacy policy published and up-to-date</td><td>Art. 9 - Access to information</td></tr>
    </tbody>
  </table>
</div>

<!-- ═══ 6. DEPENDENCIES ═══ -->
<div class="card" id="deps">
  <h2>6. Dependencies & Vulnerabilities</h2>
  <div class="metrics-grid">
    <div class="metric"><div class="value">${allDeps.dependencies}</div><div class="label">Dependencies</div></div>
    <div class="metric"><div class="value">${allDeps.devDependencies}</div><div class="label">Dev Dependencies</div></div>
    <div class="metric"><div class="value" style="color:${allAuditVulns.critical > 0 ? '#d4333f' : '#2ea44f'}">${allAuditVulns.critical}</div><div class="label">Critical Vulns</div></div>
    <div class="metric"><div class="value" style="color:${allAuditVulns.high > 0 ? '#ed7d20' : '#2ea44f'}">${allAuditVulns.high}</div><div class="label">High Vulns</div></div>
    <div class="metric"><div class="value">${allAuditVulns.moderate}</div><div class="label">Moderate Vulns</div></div>
    <div class="metric"><div class="value">${allAuditVulns.low}</div><div class="label">Low Vulns</div></div>
  </div>

  ${outdatedList.length > 0 ? `
  <h3>Outdated Packages (${outdatedList.length})</h3>
  <table>
    <thead><tr><th>Package</th><th>Current</th><th>Wanted</th><th>Latest</th><th>Location</th></tr></thead>
    <tbody>${outdatedList.slice(0, 30).map(o =>
      `<tr><td><strong>${escapeHtml(o.name)}</strong></td><td>${o.current}</td><td>${o.wanted}</td><td>${o.latest}</td><td style="font-size:12px">${escapeHtml(o.location)}</td></tr>`
    ).join('')}</tbody>
  </table>` : '<p style="color:#2ea44f;margin-top:12px">All dependencies are up to date.</p>'}
</div>

<!-- ═══ 7. ARCHITECTURE ═══ -->
<div class="card" id="architecture">
  <h2>7. Code Architecture</h2>
  <div class="metrics-grid">
    <div class="metric"><div class="value">${Number(metricsMap.ncloc || 0).toLocaleString('pt-BR')}</div><div class="label">Lines of Code</div></div>
    <div class="metric"><div class="value">${metricsMap.files || '-'}</div><div class="label">Files</div></div>
    <div class="metric"><div class="value">${metricsMap.functions || '-'}</div><div class="label">Functions</div></div>
    <div class="metric"><div class="value">${metricsMap.classes || '-'}</div><div class="label">Classes</div></div>
    <div class="metric"><div class="value">${metricsMap.statements || '-'}</div><div class="label">Statements</div></div>
    <div class="metric"><div class="value">${metricsMap.complexity || '-'}</div><div class="label">Cyclomatic Complexity</div></div>
    <div class="metric"><div class="value">${metricsMap.cognitive_complexity || '-'}</div><div class="label">Cognitive Complexity</div></div>
    <div class="metric"><div class="value">${metricsMap.duplicated_blocks || '-'}</div><div class="label">Duplicated Blocks</div></div>
  </div>
</div>

<!-- ═══ 8. TECH DEBT ═══ -->
<div class="card" id="debt">
  <h2>8. Technical Debt</h2>
  <div class="metrics-grid">
    <div class="metric"><div class="value">${debtDays}d</div><div class="label">Total Debt (days)</div></div>
    <div class="metric"><div class="value">${debtHours}h</div><div class="label">Total Debt (hours)</div></div>
    <div class="metric"><div class="value">${metricsMap.sqale_debt_ratio ? metricsMap.sqale_debt_ratio + '%' : '-'}</div><div class="label">Debt Ratio</div></div>
    <div class="metric"><div class="value">${ratingBadge(metricsMap.sqale_rating)}</div><div class="label">Maintainability Rating</div></div>
  </div>
</div>

<!-- ═══ 9. CRITICAL FILES ═══ -->
<div class="card" id="hotfiles">
  <h2>9. Files with Most Issues</h2>
  ${topFiles.length > 0 ? `
  <table>
    <thead><tr><th>File</th><th>Issues</th><th>Distribution</th></tr></thead>
    <tbody>${topFiles.map(([file, count]) => {
      const pct = Math.round((count / issueList.length) * 100);
      return `<tr>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(file)}</td>
        <td><strong>${count}</strong></td>
        <td><div style="background:#eee;border-radius:3px;height:16px;width:200px"><div style="background:#0f3460;height:100%;width:${Math.min(pct * 3, 100)}%;border-radius:3px"></div></div></td>
      </tr>`;
    }).join('')}</tbody>
  </table>` : ''}
</div>

<!-- ═══ 10. ISSUES ═══ -->
<div class="card" id="issues">
  <h2>10. Detailed Issues (top ${Math.min(issueList.length, 100)} of ${issueList.length})</h2>
  <table>
    <thead><tr><th>Severity</th><th>Type</th><th>Description</th><th>File</th></tr></thead>
    <tbody>${issueList.slice(0, 100).map(issue => {
      const file = (issue.component || '').replace(`${projectKey}:`, '');
      return `<tr>
        <td>${severityBadge(issue.severity)}</td>
        <td>${typeBadge(issue.type)}</td>
        <td>${escapeHtml(issue.message || '')}</td>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(file)}:${issue.line || ''}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>
</div>

<!-- ═══ 11. GIT ═══ -->
<div class="card" id="git">
  <h2>11. Repository Activity</h2>
  <div class="flex-row">
    <div>
      <h3>Summary</h3>
      <table>
        <tr><td>Branch</td><td><strong>${escapeHtml(gitBranch)}</strong></td></tr>
        <tr><td>Total commits</td><td><strong>${gitCommitCount}</strong></td></tr>
        <tr><td>Last commit</td><td>${escapeHtml(gitLastCommit)}</td></tr>
      </table>
    </div>
    <div>
      <h3>Top Contributors</h3>
      ${gitContributors.length > 0 ? `
      <table>
        <thead><tr><th>Name</th><th>Commits</th></tr></thead>
        <tbody>${gitContributors.map(c =>
          `<tr><td>${escapeHtml(c.name)}</td><td><strong>${c.commits}</strong></td></tr>`
        ).join('')}</tbody>
      </table>` : '<p style="color:#666">No contributor data available.</p>'}
    </div>
  </div>
</div>

<!-- ═══ 12. RECOMMENDATIONS ═══ -->
<div class="card" id="recommendations">
  <h2>12. Recommendations</h2>

  <h3>Critical Priority</h3>
  <ul>
    ${allAuditVulns.critical > 0 ? `<li>Fix <strong>${allAuditVulns.critical} critical</strong> dependency vulnerabilities immediately (<code>npm audit fix</code>)</li>` : ''}
    ${allAuditVulns.high > 0 ? `<li>Address <strong>${allAuditVulns.high} high</strong> severity dependency vulnerabilities</li>` : ''}
    ${(issuesBySeverity.BLOCKER || 0) > 0 ? `<li>Resolve <strong>${issuesBySeverity.BLOCKER} blocker</strong> code issues</li>` : ''}
    ${(issuesBySeverity.CRITICAL || 0) > 0 ? `<li>Fix <strong>${issuesBySeverity.CRITICAL} critical</strong> code issues</li>` : ''}
    ${hotspotList.length > 0 ? `<li>Review <strong>${hotspotList.length} security hotspots</strong> (blocking quality gate)</li>` : ''}
    ${lgpdIssues.length > 0 ? `<li>Fix <strong>${lgpdIssues.length} LGPD-related</strong> code violations</li>` : ''}
    ${allAuditVulns.critical === 0 && allAuditVulns.high === 0 && (issuesBySeverity.BLOCKER || 0) === 0 && (issuesBySeverity.CRITICAL || 0) === 0 && hotspotList.length === 0 && lgpdIssues.length === 0 ? '<li style="color:#2ea44f">No critical issues found.</li>' : ''}
  </ul>

  <h3>High Priority</h3>
  <ul>
    ${!metricsMap.coverage || metricsMap.coverage === '0.0' ? '<li>Implement test coverage (currently 0%)</li>' : ''}
    ${parseFloat(metricsMap.duplicated_lines_density || '0') > 5 ? `<li>Reduce code duplication (${metricsMap.duplicated_lines_density}% duplicated)</li>` : ''}
    ${debtDays > 10 ? `<li>Address technical debt (${debtDays} days of remediation effort)</li>` : ''}
    ${topFiles.length > 0 && topFiles[0][1] > 20 ? `<li>Refactor <code>${escapeHtml(topFiles[0][0])}</code> (${topFiles[0][1]} issues)</li>` : ''}
  </ul>

  <h3>LGPD Compliance</h3>
  <ul>
    ${lgpdChecks.filter(c => !c.check).map(c => `<li>${escapeHtml(c.label)}</li>`).join('')}
    ${lgpdChecks.every(c => c.check) ? '<li style="color:#2ea44f">All automated LGPD checks pass.</li>' : ''}
    <li>Complete manual review checklist (Section 5)</li>
  </ul>
</div>

<div class="footer">
  Generated by <strong>@olympio/quality-config</strong> | ${displayDate}<br>
  This report is auto-generated from SonarQube analysis, dependency audit, and git history.
</div>

</div>
</body>
</html>`;

  const reportDir = path.join(cwd, 'reports');
  ensureDir(reportDir);
  const dateSlug = now.toISOString().slice(0, 10);
  const reportFile = path.join(reportDir, `quality-report-${projectKey}-${dateSlug}.html`);
  fs.writeFileSync(reportFile, html, 'utf8');

  console.log(`  [ok] Report exported: ${path.relative(cwd, reportFile)}`);
  console.log(`  Open in browser or send to client.\n`);

  try {
    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${openCmd} "${reportFile}"`, { stdio: 'ignore' });
  } catch {}
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  case 'export':
    cmdExport();
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
