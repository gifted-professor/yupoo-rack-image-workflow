#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { projectRoot, resolvePythonRuntime } from './workflow-lib.mjs';

const python = await resolvePythonRuntime();
const result = spawnSync(python, process.argv.slice(2), {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
