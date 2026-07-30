#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

import { projectRoot, resolvePythonRuntime } from './workflow-lib.mjs';

const bootstrapPython = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

execFileSync(bootstrapPython, ['-m', 'venv', '.venv'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

const python = await resolvePythonRuntime();
execFileSync(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
  cwd: projectRoot,
  stdio: 'inherit',
});
execFileSync(python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

console.log(`Python environment ready: ${python}`);
