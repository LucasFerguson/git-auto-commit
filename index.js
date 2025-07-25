#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const simpleGit = require('simple-git');
const recursive = require('recursive-readdir');

// Configuration
const WATCH_DIR = process.cwd();
const IGNORED = /(^|[\/\\])\.git/;
const STATS_FILE = path.join(WATCH_DIR, 'repo-stats.md');
const BATCH_INTERVAL_MS = 1 * 60 * 1000;
const PULL_INTERVAL_MS = 1 * 60 * 1000; // 1 minute

// Initialize Git
const git = simpleGit(WATCH_DIR);

// Global batch timer
let batchTimer = null;
let pullTimer = null;
// let pendingChanges = false;

class Submodule {
	constructor(name, path) {
		this.name = name;
		this.path = path;
		this.git = simpleGit(path);
	}
}

let submodules = [];

class StateManager {
	constructor() {
		this.currentState = "initializing";
		// "idle"
		// "pending" – changes detected, waiting to commit
		// "committing"
		// "pulling"
		// "blocked" – bad repo state (detached head, merge conflict, etc.)
		// "error" – encountered unrecoverable error (optional)
	}
	init() {
		logInfo('State manager initialized.');
		this.setState("idle");
		setInterval(() => {
			// Only print state when idle
			if (this.currentState === "idle") {
				const nextPullMs = PULL_INTERVAL_MS - (Date.now() % PULL_INTERVAL_MS);
				logInfo(
					`State: ${this.currentState} | Next pull in: ${(nextPullMs / 1000).toFixed(1)}s`
				);
			}
		}, 10000);
	}

	setState(newState) {
		if (this.currentState !== newState) {
			logInfo(`State changed: ${this.currentState} -> ${newState}`);
			this.currentState = newState;
		}
	}

	processDone() {
		// if batch timer is running set to pedning, otherwise set to idle
		if (batchTimer) {
			this.setState("pending");
		} else {
			this.setState("idle");
		}
	}

	maybePull() {
		if (this.currentState === "idle") {
			// Only pull if we're idle and no pending changes
			logInfo('Checking for remote changes...');
			this.setState('pulling');
			pullUpdates()
				.then(() => {
					logInfo('Pull completed successfully.');
					this.setState("idle");
				})
				.catch(err => {
					logError(`Pull failed: ${err.message}`);
					this.setState("error");
				});
		} else {
			logInfo('Skipping pull, current state:' + this.currentState);
		}
	}

	// File change handler
	onChange(event, filePath) {
		this.setState("pending");
		let message = `File ${filePath} changed: ${event}`;
		if (batchTimer) {
			clearTimeout(batchTimer);
			message += ' (previous batch timer cleared)';
		}
		batchTimer = setTimeout(batchedCommit, BATCH_INTERVAL_MS);
		message += ` (next commit in ${BATCH_INTERVAL_MS / 60000} minutes)`;
		logInfo(message);
	}
}

let stateManager = new StateManager();

// Verbose logging helpers
function logInfo(msg) { console.log(`[INFO] [${new Date().toISOString()}] [${stateManager.currentState}] ${msg}`); }
function logWarn(msg) { console.warn(`[WARN] [${new Date().toISOString()}] [${stateManager.currentState}] ${msg}`); }
function logError(msg) { console.error(`[ERROR] [${new Date().toISOString()}] [${stateManager.currentState}] ${msg}`); }


// Pre-checks before watching
async function verifyRepo() {
	try {
		logInfo(`Verifying '${WATCH_DIR}' is a Git repository...`);
		const isRepo = await git.checkIsRepo();
		if (!isRepo) {
			logError('Current directory is not a Git repository. Exiting.');
			process.exit(1);
		}
		logInfo('Git repository confirmed.');

		logInfo('Checking for uncommitted changes in superproject...');
		const initialStatus = await git.status();
		if (initialStatus.files.length > 0) {
			logWarn(`You have ${initialStatus.files.length} uncommitted changes:`);
			initialStatus.files.forEach(f => logWarn(`  - ${f.path}`));
		} else {
			logInfo('No uncommitted changes detected in superproject.');
		}

		// Check .gitmodules for SSH URLs
		const gmPath = path.join(WATCH_DIR, '.gitmodules');
		if (fs.existsSync(gmPath)) {
			logInfo('Parsing .gitmodules for URL schemes...');
			const gmContent = fs.readFileSync(gmPath, 'utf8');
			const urlRegex = /^\s*url\s*=\s*(.+)$/gm;
			let match;
			while ((match = urlRegex.exec(gmContent)) !== null) {
				const url = match[1].trim();
				if (!url.startsWith('ssh://')) {
					logError(`Invalid submodule URL detected: ${url}`);
					logError('Submodule URLs must use SSH (ssh://).');
					logError('Suggestion: run `git submodule sync --recursive && git submodule update --init --recursive`.');
					logError('Also check `git config --local --list` for URL overrides.');
					process.exit(1);
				} else {
					logInfo(`SSH URL OK: ${url}`);
				}
			}
		} else {
			logInfo('No .gitmodules file found (no submodules to check URLs).');
		}

		logInfo('Retrieving submodule status...');
		const rawStatus = await git.raw(['submodule', 'status', '--recursive']);
		const lines = rawStatus.trim().split('\n').filter(Boolean);
		if (lines.length === 0) {
			logInfo('No submodules configured.');
		} else {
			for (const line of lines) {
				const prefix = line.charAt(0);
				if (prefix === '-' || prefix === '+') {
					logError(`Submodule issue detected: ${line}`);
					logError('Suggestion: run `git submodule update --init --recursive` to sync submodule commits.');
					process.exit(1);
				}
				logInfo(`Submodule OK: ${line}`);
			}
		}

		logInfo('Checking remote connectivity...');
		try {
			// Attempt to list remote heads
			await git.raw(['ls-remote', 'origin']);
			logInfo('Remote repository reachable.');
		} catch (remoteErr) {
			logError('Unable to reach remote repository.');
			logError('If you are on a local Git server, ensure your Netbird VPN is connected.');
			process.exit(1);
		}


		// ———————— FIX “dubious ownership” —————————
		// Parse every 'path = …' from .gitmodules, and for each existing folder
		if (fs.existsSync(gmPath)) {
			const gm = fs.readFileSync(gmPath, 'utf8');
			const pathRe = /^\s*path\s*=\s*(.+)$/gm;
			let m;
			while ((m = pathRe.exec(gm)) !== null) {
				const subRel = m[1].trim();
				const subFull = path.join(WATCH_DIR, subRel);

				// Add to submodules for later use
				submodules.push(new Submodule(subRel, subFull));

				if (fs.existsSync(subFull)) {
					try {
						// mark as safe.directory
						await git.raw([
							'config', '--global', '--add',
							'safe.directory', subFull
						]);
						logInfo(`Marked submodule safe.directory: ${subRel}`);
					} catch (e) {
						logWarn(`Could not mark ${subRel} safe: ${e.message}`);
					}
				} else {
					logWarn(`Skipping nonexistent submodule path: ${subRel}`);
				}
			}
		}

		// Finally, mark the superproject itself too
		try {
			await git.raw([
				'config', '--global', '--add',
				'safe.directory', WATCH_DIR
			]);
			logInfo('Marked superproject safe.directory');
		} catch (e) {
			logWarn(`Could not mark superproject safe: ${e.message}`);
		}
		// ————————————————————————————————————————

	} catch (err) {
		logError(`Repository verification failed: ${err.message}`);
		process.exit(1);
	}
}

// Generate repository stats, returning report data
async function generateStatsData() {
	const allFiles = await recursive(WATCH_DIR, ['.git']);
	const counts = {};
	allFiles.forEach(file => {
		const ext = path.extname(file).toLowerCase() || 'no_ext';
		counts[ext] = (counts[ext] || 0) + 1;
	});
	const totalFiles = allFiles.length;

	const logResult = await git.log({ maxCount: 1 });
	const lastCommitDate = new Date(logResult.latest.date);
	const firstCommitHash = (await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim();
	const firstDate = new Date((await git.raw(['show', '-s', '--format=%ci', firstCommitHash])).trim());
	const ageDays = Math.floor((new Date() - firstDate) / (1000 * 60 * 60 * 24));

	return { counts, totalFiles, lastCommitDate, ageDays };
}

async function writeStatsFile(data) {
	const { counts, totalFiles, lastCommitDate, ageDays } = data;
	const dirs = new Set(Object.keys(counts).map(() => { })); // placeholder
	let report = 'Repository Statistics Report\n';
	report += '===========================\n';
	report += `Generated on: ${new Date().toISOString()}\n\n`;
	report += `Total files: ${totalFiles}\n`;
	report += `Last commit date: ${lastCommitDate.toISOString()}\n`;
	report += `Repository age: ${ageDays} days since first commit\n`;
	report += `Files by extension:\n`;
	for (const [ext, count] of Object.entries(counts)) {
		report += `  ${ext}: ${count}\n`;
	}
	fs.writeFileSync(STATS_FILE, report, 'utf8');
	logInfo(`Stats saved to ${STATS_FILE}`);
}

// Batched commit and push function
async function batchedCommit() {
	logInfo('Performing batched commit...');
	stateManager.setState("committing");

	// Create base commit message object
	const baseCommitObj = {
		author: 'pve3 Obsidian-Phone',
		date: new Date().toISOString().replace('T', ' ').slice(0, 19),
		lines: { added: 0, removed: 0 },
	};

	// 1) Commit & push submodules
	const submodStatus = (await git.raw(['submodule', 'status', '--recursive']))
		.trim().split('\n').filter(Boolean);
	const folderNames = submodStatus.map(line => {
		const cleaned = line.replace(/^[-+ ]/, '').trim();
		return cleaned.split(/\s+/)[1] || '';
	});
	logInfo(`Submodule folders: ${folderNames.join(', ')}`);

	for (const folderName of folderNames) {
		const subPath = path.join(WATCH_DIR, folderName);
		if (!fs.existsSync(subPath)) {
			logWarn(`Skipping missing submodule path: ${folderName}`);
			continue;
		}

		const subGit = simpleGit(subPath);
		const statusSummary = await subGit.status();
		const currentBranch = (await subGit.branchLocal()).current;

		if (statusSummary.files.length > 0) {
			await subGit.add('.');
			const commitObj = {
				...baseCommitObj,
				numFiles: statusSummary.files.length,
			};
			const commitMsg = JSON.stringify(commitObj);

			try {
				await subGit.commit(commitMsg);
				logInfo(`Committed submodule ${folderName}, with message: "${commitMsg}"`);
			} catch (e) {
				logWarn(`Failed to commit submodule ${folderName}: ${e.message}`);
				continue;
			}

			if (currentBranch !== 'main') {
				try {
					await subGit.checkout('main');
					logInfo(`Checked out 'main' in submodule ${folderName}`);
				} catch (e) {
					logWarn(`Failed to checkout 'main' in submodule ${folderName}: ${e.message}`);
					continue;
				}
			}

			try {
				await subGit.push('origin', 'main');
				logInfo(`Pushed submodule ${folderName} to main`);
			} catch (e) {
				logWarn(`Failed to push submodule ${folderName}: ${e.message}`);
			}
		} else {
			logInfo(`No changes to commit in submodule ${folderName}`);
		}
	}


	// 2) Commit & push superproject
	const mainStatus = await git.status();

	const hasChanges =
		mainStatus.files.length > 0 ||
		(mainStatus.submodules && mainStatus.submodules.length > 0);

	if (hasChanges) {
		await git.add('.');

		const commitObj = {
			...baseCommitObj,
			numFiles: mainStatus.files.length,
			numSubmodules: mainStatus.submodules?.length || 0,
		};
		const commitMsg = JSON.stringify(commitObj);

		try {
			await git.commit(commitMsg);
			logInfo(`Superproject committed, with message: "${commitMsg}"`);
		} catch (e) {
			logWarn(`Failed to commit superproject: ${e.message}`);
			return;
		}

		const branch = (await git.branchLocal()).current;
		if (branch) {
			try {
				await git.push('origin', branch);
				logInfo(`Superproject pushed to ${branch}`);
			} catch (e) {
				logWarn(`Failed to push superproject: ${e.message}`);
			}
		} else {
			logWarn('Superproject is in a detached HEAD; skipping push.');
		}
	} else {
		logInfo('No superproject or submodule pointer changes to commit');
	}

	// Finalize
	batchTimer = null;
	stateManager.processDone();
}

async function pullUpdates() {
	logInfo('Attempting to pull latest changes...');

	try {
		await git.pull('origin', 'main');
		logInfo('Pulled latest changes in superproject');
	} catch (e) {
		logWarn(`Failed to pull superproject: ${e.message}`);
	}
	for (const sub of submodules) {
		try {
			const currentBranch = (await sub.git.branchLocal()).current;
			if (currentBranch !== 'main') {
				logWarn(`Skipping pull in ${sub.path} (not on main)`);
				continue;
			}

			await sub.git.pull('origin', 'main');
			logInfo(`Pulled latest changes in submodule ${sub.path}`);
		} catch (e) {
			logWarn(`Failed to pull submodule ${sub.path}: ${e.message}`);
		}
	}

	stateManager.processDone();
}


// Main
(async () => {
	await verifyRepo();
	await writeStatsFile(await generateStatsData());

	await stateManager.init();
	logInfo('Initialization complete. Watching for changes...');
	chokidar.watch(WATCH_DIR, { ignored: IGNORED, persistent: true, ignoreInitial: true })
		.on('all', stateManager.onChange.bind(stateManager));

	pullTimer = setInterval(() => stateManager.maybePull(), PULL_INTERVAL_MS);
})();
