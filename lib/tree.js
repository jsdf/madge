'use strict';

const os = require('os');
const path = require('path');
const {promisify} = require('util');
const commondir = require('commondir');
const walk = require('walkdir');
const dependencyTree = require('dependency-tree');
const log = require('./log');
const DependencyCache = require('./cache');

const stat = promisify(require('fs').stat);

/**
 * Check if running on Windows.
 * @type {Boolean}
 */
const isWin = (os.platform() === 'win32');

class Tree {
	/**
	 * Class constructor.
	 * @constructor
	 * @api public
	 * @param {Array} srcPaths
	 * @param {Object} config
	 * @return {Promise}
	 */
	constructor(srcPaths, config) {
		this.srcPaths = srcPaths.map((s) => path.resolve(s));
		log('using src paths %o', this.srcPaths);

		this.config = config;
		log('using config %o', this.config);

		this.cache = new DependencyCache(config.cacheFile);

		return this.cache.load()
			.then(() => this.getDirs())
			.then(this.setBaseDir.bind(this))
			.then(this.getFiles.bind(this))
			.then(this.generateTree.bind(this))
			.then((result) => {
				return this.cache.save().then(() => result);
			});
	}

	/**
	 * Set the base directory (compute the common one if multiple).
	 * @param {Array} dirs
	 */
	setBaseDir(dirs) {
		if (this.config.baseDir) {
			this.baseDir = path.resolve(this.config.baseDir);
		} else {
			this.baseDir = commondir(dirs);
		}

		log('using base directory %s', this.baseDir);
	}

	/**
	 * Get directories from the source paths
	 * @return {Promise} resolved with an array of directories
	 */
	getDirs() {
		return Promise
			.all(this.srcPaths.map((srcPath) => {
				return stat(srcPath)
					.then((stats) => stats.isDirectory() ? srcPath : path.dirname(path.resolve(srcPath)));
			}));
	}

	/**
	 * Get all files found from the source paths
	 * @return {Promise} resolved with an array of files
	 */
	getFiles() {
		const files = [];

		return Promise
			.all(this.srcPaths.map((srcPath) => {
				return stat(srcPath)
					.then((stats) => {
						if (stats.isFile()) {
							if (this.isGitPath(srcPath)) {
								return;
							}

							files.push(path.resolve(srcPath));

							return;
						}

						walk.sync(srcPath, (filePath, stat) => {
							if (this.isGitPath(filePath) || this.isNpmPath(filePath) || !stat.isFile()) {
								return;
							}

							const ext = path.extname(filePath).replace('.', '');

							if (files.indexOf(filePath) < 0 && this.config.fileExtensions.indexOf(ext) >= 0) {
								files.push(filePath);
							}
						});
					});
			}))
			.then(() => files);
	}

	/**
	 * Generate the tree from the given files
	 * @param  {Array} files
	 * @return {Object}
	 */
	async generateTree(files) {
		const depTree = {};
		const visited = {};
		const nonExistent = [];
		const npmPaths = {};
		const pathCache = {};

		// Load cached dependencies if available
		const cachedDeps = await this.loadCachedDependencies(files);

		// Build tree from cached entries first
		this.populateVisitedFromCache(cachedDeps, visited);

		// Process files that weren't fully cached
		await this.processUncachedFiles(files, visited, depTree, npmPaths, nonExistent);

		let tree = this.convertTree(depTree, {}, pathCache, npmPaths);

		this.addNpmPaths(tree, npmPaths, pathCache);

		if (this.config.excludeRegExp) {
			tree = this.exclude(tree, this.config.excludeRegExp);
		}

		return {
			tree: this.sort(tree),
			skipped: nonExistent
		};
	}

	/**
	 * Load cached dependencies for files if cache is enabled.
	 * @param {Array} files
	 * @return {Promise<Object>}
	 */
	async loadCachedDependencies(files) {
		const cachedDeps = {};
		if (!this.cache.isEnabled()) {
			return cachedDeps;
		}

		// Set to track files currently being validated to handle circular deps
		const validating = new Set();
		const validatedFiles = new Set();

		/**
		 * Recursively validate a file and all its dependencies.
		 * @param {String} file
		 * @return {Promise<Boolean>}
		 */
		const validateFileRecursively = async (file) => {
			// Already validated
			if (validatedFiles.has(file)) {
				return true;
			}

			// Currently validating - circular dependency, consider valid
			if (validating.has(file)) {
				return true;
			}

			validating.add(file);

			const cached = await this.cache.get(file);
			if (cached === null) {
				validating.delete(file);
				return false;
			}

			// Validate all dependencies recursively
			for (const dep of cached) {
				const depValid = await validateFileRecursively(dep);
				if (!depValid) {
					validating.delete(file);
					return false;
				}
			}

			validating.delete(file);
			validatedFiles.add(file);
			cachedDeps[file] = cached;
			return true;
		};

		for (const file of files) {
			await validateFileRecursively(file);
		}

		return cachedDeps;
	}

	/**
	 * Populate visited object from cached dependencies.
	 * @param {Object} cachedDeps
	 * @param {Object} visited
	 */
	populateVisitedFromCache(cachedDeps, visited) {
		// Build nested tree structure from flat cache
		const buildNestedTree = (file, building) => {
			// Prevent infinite loops for circular dependencies
			if (building.has(file)) {
				return visited[file] || {};
			}
			building.add(file);

			if (visited[file]) {
				return visited[file];
			}

			const deps = cachedDeps[file];
			if (!deps) {
				visited[file] = {};
				return visited[file];
			}

			visited[file] = {};
			for (const dep of deps) {
				visited[file][dep] = buildNestedTree(dep, building);
			}
			return visited[file];
		};

		for (const file in cachedDeps) {
			buildNestedTree(file, new Set());
		}
	}

	/**
	 * Process files that were not found in cache.
	 * @param {Array} files
	 * @param {Object} visited
	 * @param {Object} depTree
	 * @param {Object} npmPaths
	 * @param {Array} nonExistent
	 * @return {Promise}
	 */
	async processUncachedFiles(files, visited, depTree, npmPaths, nonExistent) {
		for (const file of files) {
			if (visited[file]) {
				Object.assign(depTree, {[file]: visited[file]});
				continue;
			}

			const result = this.callDependencyTree(file, visited, npmPaths, nonExistent);
			Object.assign(depTree, result);

			if (this.cache.isEnabled()) {
				await this.updateCacheFromTree(result);
			}
		}
	}

	/**
	 * Call dependency-tree for a single file.
	 * @param {String} file
	 * @param {Object} visited
	 * @param {Object} npmPaths
	 * @param {Array} nonExistent
	 * @return {Object}
	 */
	callDependencyTree(file, visited, npmPaths, nonExistent) {
		return dependencyTree({
			filename: file,
			directory: this.baseDir,
			requireConfig: this.config.requireConfig,
			webpackConfig: this.config.webpackConfig,
			tsConfig: this.config.tsConfig,
			visited: visited,
			filter: (dependencyFilePath, traversedFilePath) => {
				return this.filterDependency(dependencyFilePath, traversedFilePath, npmPaths);
			},
			detective: this.config.detectiveOptions,
			nonExistent: nonExistent
		});
	}

	/**
	 * Filter function for dependency-tree.
	 * @param {String} dependencyFilePath
	 * @param {String} traversedFilePath
	 * @param {Object} npmPaths
	 * @return {Boolean}
	 */
	filterDependency(dependencyFilePath, traversedFilePath, npmPaths) {
		let dependencyFilterRes = true;
		const isNpmPath = this.isNpmPath(dependencyFilePath);

		if (this.isGitPath(dependencyFilePath)) {
			return false;
		}

		if (this.config.dependencyFilter) {
			dependencyFilterRes = this.config.dependencyFilter(dependencyFilePath, traversedFilePath, this.baseDir);
		}

		if (this.config.includeNpm && isNpmPath) {
			(npmPaths[traversedFilePath] = npmPaths[traversedFilePath] || []).push(dependencyFilePath);
		}

		return !isNpmPath && (dependencyFilterRes || dependencyFilterRes === undefined);
	}

	/**
	 * Add NPM paths to the tree.
	 * @param {Object} tree
	 * @param {Object} npmPaths
	 * @param {Object} pathCache
	 */
	addNpmPaths(tree, npmPaths, pathCache) {
		for (const npmKey in npmPaths) {
			const id = this.processPath(npmKey, pathCache);
			npmPaths[npmKey].forEach((npmPath) => {
				tree[id].push(this.processPath(npmPath, pathCache));
			});
		}
	}

	/**
	 * Update cache from a dependency tree result.
	 * @param {Object} tree - Tree from dependency-tree
	 * @param {Set} seen - Set of files already processed to avoid overwriting
	 * @return {Promise}
	 */
	async updateCacheFromTree(tree, seen = new Set()) {
		for (const file in tree) {
			// Skip if we've already cached this file in this update cycle
			// This prevents circular dependencies from overwriting valid entries
			if (seen.has(file)) {
				continue;
			}
			seen.add(file);

			const deps = Object.keys(tree[file]);
			await this.cache.set(file, deps);
			// Recursively update cache for nested dependencies
			await this.updateCacheFromTree(tree[file], seen);
		}
	}

	/**
	 * Convert deep tree produced by dependency-tree to a
	 * shallow (one level deep) tree used by madge.
	 * @param  {Object} depTree
	 * @param  {Object} tree
	 * @param  {Object} pathCache
	 * @return {Object}
	 */
	convertTree(depTree, tree, pathCache) {
		for (const key in depTree) {
			const id = this.processPath(key, pathCache);

			if (!tree[id]) {
				tree[id] = [];

				for (const dep in depTree[key]) {
					tree[id].push(this.processPath(dep, pathCache));
				}

				this.convertTree(depTree[key], tree, pathCache);
			}
		}

		return tree;
	}

	/**
	 * Process absolute path and return a shorter one.
	 * @param  {String} absPath
	 * @param  {Object} cache
	 * @return {String}
	 */
	processPath(absPath, cache) {
		if (cache[absPath]) {
			return cache[absPath];
		}

		let relPath = path.relative(this.baseDir, absPath);

		if (isWin) {
			relPath = relPath.replace(/\\/g, '/');
		}

		cache[absPath] = relPath;

		return relPath;
	}

	/**
	 * Check if path is from NPM folder
	 * @param  {String} path
	 * @return {Boolean}
	 */
	isNpmPath(path) {
		return path.indexOf('node_modules') >= 0;
	}

	/**
	 * Check if path is from .git folder
	 * @param  {String} filePath
	 * @return {Boolean}
	 */
	isGitPath(filePath) {
		return filePath.split(path.sep).indexOf('.git') !== -1;
	}

	/**
	 * Exclude modules from tree using RegExp.
	 * @param  {Object} tree
	 * @param  {Array} excludeRegExp
	 * @return {Object}
	 */
	exclude(tree, excludeRegExp) {
		const regExpList = excludeRegExp.map((re) => new RegExp(re));

		function regExpFilter(id) {
			return regExpList.findIndex((regexp) => regexp.test(id)) < 0;
		}

		return Object
			.keys(tree)
			.filter(regExpFilter)
			.reduce((acc, id) => {
				acc[id] = tree[id].filter(regExpFilter);
				return acc;
			}, {});
	}

	/**
	 * Sort tree.
	 * @param  {Object} tree
	 * @return {Object}
	 */
	sort(tree) {
		return Object
			.keys(tree)
			.sort()
			.reduce((acc, id) => {
				acc[id] = tree[id].sort();
				return acc;
			}, {});
	}
}

/**
 * Expose API.
 * @param {Array} srcPaths
 * @param {Object} config
 * @return {Promise}
 */
module.exports = (srcPaths, config) => new Tree(srcPaths, config);
