#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { projectRoot, resolvePythonRuntime } from './workflow-lib.mjs';

const python = await resolvePythonRuntime();
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
