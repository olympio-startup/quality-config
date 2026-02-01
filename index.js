const path = require('path');

const CONFIGS_DIR = path.join(__dirname, 'configs');
const WORKFLOWS_DIR = path.join(__dirname, 'workflows');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

const SUPPORTED_STACKS = ['react', 'nextjs', 'node', 'react-native', 'python-django', 'python-fastapi'];

module.exports = {
  CONFIGS_DIR,
  WORKFLOWS_DIR,
  SCRIPTS_DIR,
  TEMPLATES_DIR,
  SUPPORTED_STACKS,
};
