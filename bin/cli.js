#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIGS_DIR = path.join(__dirname, '..', 'configs');
const WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows');
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
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

function printHelp() {
  console.log(`
@olympio/quality-config - Unified quality & compliance tooling

Usage:
  quality-config init [options]     Setup quality configs in current project
  quality-config doctor             Check if everything is configured correctly
  quality-config report             Generate LGPD compliance report
  quality-config update             Update configs to latest version

Options for init:
  --stack <stack>       Project stack (${Object.keys(STACKS).join(', ')})
  --project-key <key>   SonarQube project key
  --project-name <name> SonarQube project display name
  --sonar-url <url>     SonarQube server URL (default: uses SONAR_HOST_URL env)
  --skip-workflow       Don't generate GitHub Actions workflow
  --skip-docker         Don't generate docker-compose for SonarQube
  --skip-lgpd           Don't generate LGPD compliance configs

Examples:
  quality-config init --stack react --project-key my-app
  quality-config init --stack python-django --project-key api-service
  quality-config doctor
  quality-config report
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

function generateSonarProperties(cwd, opts, stackConfig) {
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
}

function generateDockerCompose(cwd) {
  const src = path.join(CONFIGS_DIR, 'docker-compose.sonar.yml');
  const dest = path.join(cwd, 'docker-compose.sonar.yml');
  fs.copyFileSync(src, dest);
  console.log('  [created] docker-compose.sonar.yml');
}

function generateWorkflow(cwd, stackConfig) {
  const templateName = stackConfig.lang === 'py'
    ? 'sonarqube-python.yml.tpl'
    : 'sonarqube-node.yml.tpl';

  ensureDir(path.join(cwd, '.github', 'workflows'));
  copyTemplate(
    templateName,
    path.join(cwd, '.github', 'workflows', 'sonarqube.yml'),
    { NODE_VERSION: stackConfig.nodeVersion || '18' }
  );
  console.log('  [created] .github/workflows/sonarqube.yml');
}

function generateLgpdConfigs(cwd, stackConfig) {
  const rulesFile = stackConfig.lang === 'py'
    ? 'lgpd-rules-python.json'
    : 'lgpd-rules-js.json';

  fs.copyFileSync(
    path.join(CONFIGS_DIR, 'lgpd', rulesFile),
    path.join(cwd, '.sonarqube-lgpd-rules.json')
  );
  console.log('  [created] .sonarqube-lgpd-rules.json');

  ensureDir(path.join(cwd, 'scripts'));
  fs.copyFileSync(
    path.join(SCRIPTS_DIR, 'generate-lgpd-report.sh'),
    path.join(cwd, 'scripts', 'generate-lgpd-report.sh')
  );
  fs.chmodSync(path.join(cwd, 'scripts', 'generate-lgpd-report.sh'), '755');
  console.log('  [created] scripts/generate-lgpd-report.sh');
}

function generateGitignoreEntries(cwd) {
  const entries = [
    '',
    '# Quality & SonarQube',
    '.scannerwork/',
    'dependency-check-report.*',
    'reports/',
  ];

  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const current = fs.readFileSync(gitignorePath, 'utf8');
    if (!current.includes('.scannerwork')) {
      fs.appendFileSync(gitignorePath, entries.join('\n') + '\n');
      console.log('  [updated] .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, entries.join('\n') + '\n');
    console.log('  [created] .gitignore');
  }
}

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

  generateSonarProperties(cwd, opts, stackConfig);

  if (!opts.skipDocker) {
    generateDockerCompose(cwd);
  }

  if (!opts.skipWorkflow) {
    generateWorkflow(cwd, stackConfig);
  }

  if (!opts.skipLgpd) {
    generateLgpdConfigs(cwd, stackConfig);
  }

  generateGitignoreEntries(cwd);

  console.log('\nDone! Next steps:');
  console.log('  1. Set SONAR_TOKEN and SONAR_HOST_URL in your GitHub repo secrets');
  console.log('  2. Run: docker compose -f docker-compose.sonar.yml up -d  (for local SonarQube)');
  console.log('  3. Run: quality-config doctor  (to verify setup)');
  console.log('');
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
    { file: 'scripts/generate-lgpd-report.sh', label: 'LGPD report script' },
  ];

  for (const check of checks) {
    const exists = fs.existsSync(path.join(cwd, check.file));
    const icon = exists ? '[ok]' : '[missing]';
    console.log(`  ${icon} ${check.label} (${check.file})`);
    if (!exists) issues++;
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

  // Check env vars
  if (!process.env.SONAR_TOKEN && !process.env.SONAR_HOST_URL) {
    console.log('\n  [info] SONAR_TOKEN and SONAR_HOST_URL env vars not set (needed for CI)');
  }

  console.log(`\n${issues === 0 ? 'All checks passed!' : `${issues} issue(s) found.`}\n`);
}

function cmdReport() {
  const cwd = process.cwd();
  const script = path.join(cwd, 'scripts', 'generate-lgpd-report.sh');

  if (!fs.existsSync(script)) {
    console.error('Error: scripts/generate-lgpd-report.sh not found. Run "quality-config init" first.');
    process.exit(1);
  }

  execSync(`bash "${script}"`, { stdio: 'inherit', cwd });
}

function cmdUpdate() {
  const cwd = process.cwd();

  if (!fs.existsSync(path.join(cwd, 'sonar-project.properties'))) {
    console.error('Error: No quality-config found in this project. Run "quality-config init" first.');
    process.exit(1);
  }

  // Update non-project-specific files
  const filesToUpdate = [
    { src: path.join(CONFIGS_DIR, 'docker-compose.sonar.yml'), dest: 'docker-compose.sonar.yml' },
    { src: path.join(SCRIPTS_DIR, 'generate-lgpd-report.sh'), dest: 'scripts/generate-lgpd-report.sh' },
  ];

  console.log('\nUpdating shared configs...\n');

  for (const { src, dest } of filesToUpdate) {
    const destPath = path.join(cwd, dest);
    if (fs.existsSync(destPath)) {
      fs.copyFileSync(src, destPath);
      console.log(`  [updated] ${dest}`);
    }
  }

  console.log('\nDone! sonar-project.properties was NOT changed (project-specific).\n');
}

// Main
switch (command) {
  case 'init':
    cmdInit(args.slice(1));
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
