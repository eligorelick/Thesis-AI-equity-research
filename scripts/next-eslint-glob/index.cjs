/* eslint-disable @typescript-eslint/no-require-imports -- Next loads this adapter through CommonJS require. */
/* Bounded adapter for @next/eslint-plugin-next's one fast-glob call.
 * This is deliberately not a general fast-glob replacement. Unsupported root
 * patterns fail loudly so Next's internal-link rule cannot silently disappear.
 */
const fs = require('node:fs');
const path = require('node:path');
const { globSync: glob } = require('tinyglobby');

exports.globSync = function globSync(pattern, options) {
  if (typeof pattern !== 'string' || !options || options.onlyDirectories !== true ||
      Object.keys(options).length !== 1) {
    throw new Error('Next ESLint globSync requires a string and {onlyDirectories:true}');
  }
  const terminalGlobstar = pattern.endsWith('/**');
  const prefix = terminalGlobstar ? pattern.slice(0, -3) : pattern;
  if (pattern.length > 4096 || /[{}()[\]?]/.test(pattern) || prefix.includes('**') ||
      (pattern.includes('!') && !pattern.startsWith('!'))) {
    throw new Error('Unsupported Next ESLint rootDir pattern: use literal directories, * segments or one terminal /**');
  }
  if (pattern.startsWith('!')) return [];
  if (!pattern.includes('*')) {
    try { return fs.statSync(pattern).isDirectory() ? [pattern] : []; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
  }
  const matches = glob(pattern, {
    onlyDirectories: true,
    expandDirectories: false,
    absolute: path.isAbsolute(pattern),
    dot: false,
    followSymbolicLinks: false,
  }).map((entry) => entry.replace(/\/$/, ''));
  // fast-glob excludes the literal base of "root/**", but includes the
  // matched bases of "root/*/**". tinyglobby includes both.
  const literalBase = terminalGlobstar && !prefix.includes('*')
    ? prefix.replace(/^\.\//, '').replace(/\/$/, '') : null;
  return [...new Set(matches.filter((entry) => entry !== literalBase))];
};
