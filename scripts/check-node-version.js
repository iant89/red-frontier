#!/usr/bin/env node
/*
 * Keep this check deliberately old-syntax and dependency-free. npm runs lifecycle
 * scripts before loading the ESM entry points, so users with an old Node binary get
 * an actionable message instead of a parser error from publish-wiki.mjs.
 */
'use strict';

var requiredMajor = 18;
var version = process.versions && process.versions.node;
var major = version ? parseInt(version.split('.')[0], 10) : NaN;

if (!version || isNaN(major) || major < requiredMajor) {
  console.error('Red Frontier requires Node.js ' + requiredMajor + ' or newer.');
  console.error('Detected Node.js ' + (version || 'an unknown version') + '.');
  console.error('Install or update Node.js LTS, then run this command again.');
  console.error('See https://nodejs.org/ or run ./launchers/setup_ubuntu.sh on Ubuntu/Debian.');
  process.exit(1);
}
