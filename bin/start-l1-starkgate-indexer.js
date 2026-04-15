#!/usr/bin/env node
'use strict';

require.extensions['.ts'] = require.extensions['.js'];
require('../src/indexers/l1-starkgate-indexer.ts').main();
