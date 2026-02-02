const path = require('path');

const CONFIGS_DIR = path.join(__dirname, 'configs');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

const SUPPORTED_STACKS = ['react', 'nextjs', 'node', 'react-native', 'python-django', 'python-fastapi'];

module.exports = {
  CONFIGS_DIR,
  TEMPLATES_DIR,
  SUPPORTED_STACKS,
};
