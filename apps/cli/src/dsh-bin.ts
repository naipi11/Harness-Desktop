#!/usr/bin/env node

import { runCli } from './main.ts'

process.exitCode = await runCli('dsh')
