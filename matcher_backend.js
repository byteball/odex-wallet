const { spawn } = require('child_process');
const conf = require('ocore/conf.js');

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
			cwd: process.env.HOME + "/go/src/github.com/byteball/odex-backend",
			env: {
				...process.env,
				GO_ENV: conf.backendEnvironment,
			},
			shell: true,
		});

		go.on('error', (err) => {
			console.log(`Failed to start 'go run ${process.env.HOME}/go/src/github.com/byteball/odex-backend/main.go'. Did you install odex-backend?`);
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
