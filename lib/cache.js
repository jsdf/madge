'use strict';

const fs = require('fs');
const path = require('path');
const {promisify} = require('util');
const log = require('./log');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const stat = promisify(fs.stat);

/**
 * Cache for storing file dependencies with mtime validation.
 * Format: { version: 1, entries: { [absolutePath]: { mtime: number, dependencies: string[] } } }
 */
class DependencyCache {
	/**
	 * Class constructor.
	 * @constructor
	 * @param {String|null} cacheFile - Path to the cache file
	 */
	constructor(cacheFile) {
		this.cacheFile = cacheFile;
		this.cache = null;
		this.dirty = false;
		this.version = 1;
	}

	/**
	 * Load cache from disk.
	 * @return {Promise}
	 */
	async load() {
		if (!this.cacheFile) {
			this.cache = {version: this.version, entries: {}};
			return;
		}

		try {
			const data = await readFile(this.cacheFile, 'utf8');
			const parsed = JSON.parse(data);

			// Check cache version compatibility
			if (parsed.version === this.version) {
				this.cache = parsed;
				log('loaded cache from %s with %d entries', this.cacheFile, Object.keys(this.cache.entries).length);
			} else {
				log('cache version mismatch, starting fresh');
				this.cache = {version: this.version, entries: {}};
			}
		} catch (err) {
			if (err.code === 'ENOENT') {
				log('cache file not found, starting fresh');
			} else {
				log('failed to load cache: %s', err.message);
			}
			this.cache = {version: this.version, entries: {}};
		}
	}

	/**
	 * Save cache to disk if dirty.
	 * @return {Promise}
	 */
	async save() {
		if (!this.cacheFile || !this.dirty) {
			return;
		}

		try {
			const dir = path.dirname(this.cacheFile);

			// Ensure directory exists
			try {
				await stat(dir);
			} catch (err) {
				if (err.code === 'ENOENT') {
					await promisify(fs.mkdir)(dir, {recursive: true});
				}
			}

			await writeFile(this.cacheFile, JSON.stringify(this.cache, null, 2));
			log('saved cache to %s with %d entries', this.cacheFile, Object.keys(this.cache.entries).length);
		} catch (err) {
			log('failed to save cache: %s', err.message);
		}
	}

	/**
	 * Get cached dependencies for a file if the mtime matches.
	 * @param {String} filePath - Absolute path to the file
	 * @return {Promise<Array|null>} - Array of dependencies or null if not cached/stale
	 */
	async get(filePath) {
		if (!this.cache) {
			return null;
		}

		const entry = this.cache.entries[filePath];
		if (!entry) {
			return null;
		}

		try {
			const stats = await stat(filePath);
			const mtime = stats.mtimeMs;

			if (entry.mtime === mtime) {
				log('cache hit for %s', filePath);
				return entry.dependencies;
			}

			log('cache stale for %s (mtime changed)', filePath);
			return null;
		} catch (err) {
			log('failed to stat file %s: %s', filePath, err.message);
			return null;
		}
	}

	/**
	 * Set cached dependencies for a file.
	 * @param {String} filePath - Absolute path to the file
	 * @param {Array} dependencies - Array of absolute dependency paths
	 * @return {Promise}
	 */
	async set(filePath, dependencies) {
		if (!this.cache) {
			return;
		}

		try {
			const stats = await stat(filePath);
			const mtime = stats.mtimeMs;

			this.cache.entries[filePath] = {
				mtime,
				dependencies
			};
			this.dirty = true;
			log('cached dependencies for %s', filePath);
		} catch (err) {
			log('failed to cache file %s: %s', filePath, err.message);
		}
	}

	/**
	 * Check if caching is enabled.
	 * @return {Boolean}
	 */
	isEnabled() {
		return Boolean(this.cacheFile);
	}
}

module.exports = DependencyCache;
