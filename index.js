#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const simpleGit = require('simple-git');
const recursive = require('recursive-readdir');

// Configuration
const WATCH_DIR = process.cwd();
const COMMIT_MSG_SUPER = 'Auto‑commit in superproject';
const IGNORED = /(^|[\/\\])\.git/;
const DEBOUNCE_MS = 500;
const STATS_FILE = path.join(WATCH_DIR, 'repo-stats.txt');

// Initialize Git
const git = simpleGit(WATCH_DIR);

// Debounce helper
let commitTimeout;
function debounce(fn) {
	clearTimeout(commitTimeout);
	commitTimeout = setTimeout(fn, DEBOUNCE_MS);
}

// Verbose logging helpers
function logInfo(msg) { console.log(`[INFO] ${msg}`); }
function logWarn(msg) { console.warn(`[WARN] ${msg}`); }
function logError(msg) { console.error(`[ERROR] ${msg}`); }

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

	} catch (err) {
		logError(`Repository verification failed: ${err.message}`);
		process.exit(1);
	}
}

// Generate fun statistics about the repo
async function generateStats() {
	logInfo('Generating repository statistics...');

	// 1) Count files by extension
	const allFiles = await recursive(WATCH_DIR, ['.git']);
	const counts = {};
	allFiles.forEach(file => {
		const ext = path.extname(file).toLowerCase() || 'no_ext';
		counts[ext] = (counts[ext] || 0) + 1;
	});

	// 2) Repo age and last commit
	const log = await git.log({ maxCount: 1 });
	const lastCommitDate = new Date(log.latest.date);
	const now = new Date();
	const ageDays = Math.floor((now - new Date((await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim())) / (1000 * 60 * 60 * 24));

	// 3) Total folders
	const dirs = new Set(allFiles.map(f => path.dirname(f)));

	// 4) Other fun stats
	const totalFiles = allFiles.length;
	const totalDirs = dirs.size;
	const topExt = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

	// Build report
	let report = 'Repository Statistics Report\n';
	report += '===========================\n';
	report += `Generated on: ${now.toISOString()}\n\n`;
	report += `Total files: ${totalFiles}\n`;
	report += `Total directories: ${totalDirs}\n`;
	report += `Last commit date: ${lastCommitDate.toISOString()}\n`;
	report += `Repository age: ${ageDays} days since first commit\n`;
	report += `Most common extension: ${topExt[0]} (${topExt[1]} files)\n\n`;
	report += 'Files by extension:\n';
	for (const [ext, count] of Object.entries(counts)) {
		report += `  ${ext}: ${count}\n`;
	}

	// Write to file
	fs.writeFileSync(STATS_FILE, report, 'utf8');
	logInfo(`Statistics written to ${STATS_FILE}`);
}

// Auto‑commit handler
async function autoCommit() {
	try {
		logInfo('Starting auto‑commit sequence...');

		// 1) Handle submodules recursively
		logInfo('Checking submodules for changes...');
		await git.raw(['submodule', 'foreach', '--recursive',
			'bash -lc "if [ -n \"$(git status --porcelain)\" ]; then ' +
			'git add -A && git commit -m \"Auto‑commit in submodule $(basename `pwd`)\" && ' +
			'echo \"[INFO] Committed in submodule $(basename `pwd`)\"; fi"'
		]);

		// 2) Handle superproject
		logInfo('Checking superproject for changes...');
		const status = await git.status();
		if (status.files.length > 0) {
			logInfo(`Found ${status.files.length} changed files in superproject.`);
			await git.add('.');
			await git.commit(COMMIT_MSG_SUPER);
			logInfo('Committed changes in superproject.');
		} else {
			logInfo('No changes to commit in superproject.');
		}

		logInfo('Auto‑commit sequence completed.');
	} catch (err) {
		logError(`Auto‑commit error: ${err.message}`);
	}
}

// Main entrypoint
(async () => {
	await verifyRepo();
	await generateStats();

	logInfo(`Initialization complete. You may now start editing.`);
	logInfo(`Watching ${WATCH_DIR} for changes (excluding '.git')…`);
	chokidar.watch(WATCH_DIR, {
		ignored: IGNORED,
		persistent: true,
		ignoreInitial: true,
	})
		.on('all', (event, filePath) => {
			logInfo(`Detected ${event} on ${filePath}`);
			debounce(async () => {
				await autoCommit();
				await generateStats();
			});
		});
})();
