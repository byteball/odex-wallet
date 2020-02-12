const { spawn } = require('child_process');
const conf = require('./conf.js');

async function start() {
	return new Promise(resolve => {
		let bStarted = false;

		function onStarted() {
			if (bStarted)
				return;
			bStarted = true;
			resolve();
		}

		const go = spawn('go run main.go', {
			cwd: process.env.HOME + "/go/src/github.com/Proofsuite/amp-matching-engine",
			env: {
				...process.env,
				GO_ENV: conf.backendEnvironment,
			},
			shell: true,
		});

		go.stdout.on('data', (data) => {
			console.error(`++ go stdout: ${data}`);
			onStarted();
		});

		go.stderr.on('data', (data) => {
			console.error(`++ go stderr: ${data}`);
			onStarted();
		});

		go.on('close', (code) => {
			console.log(`go child process exited with code ${code}`);
			process.exit();
		});
	});
}

exports.start = start;
