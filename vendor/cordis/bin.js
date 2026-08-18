#!/usr/bin/env node

import { Context } from '@harness-desktop/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@harness-desktop/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@harness-desktop/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
