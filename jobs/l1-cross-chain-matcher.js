#!/usr/bin/env node
'use strict';

require.extensions['.ts'] = require.extensions['.js'];
require('../src/jobs/l1-cross-chain-matcher.ts').main();
