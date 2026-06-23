// SPDX-License-Identifier: AGPL-3.0-or-later

import {createServer} from 'node:http';
import {chown, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const DATA_DIR = process.env.PROVISIONER_DATA_DIR ?? '/var/lib/fluxer_bot_provisioner';
const AUTH_TOKEN = process.env.PROVISIONER_AUTH_TOKEN ?? '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE ?? 'ghcr.io/openclaw/openclaw:latest';
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? 'fluxer_fluxer';
const OPENCLAW_UID = Number.parseInt(process.env.OPENCLAW_UID ?? '1000', 10);
const OPENCLAW_GID = Number.parseInt(process.env.OPENCLAW_GID ?? '1000', 10);

const PERSONA_FILE_NAMES = ['AGENTS', 'SOUL', 'TOOLS'];
const PERSONA_FILE_NAME_SET = new Set(PERSONA_FILE_NAMES);
const LEGACY_PERSONA_FILE_NAMES = ['IDENTITY', 'USER', 'HEARTBEAT', 'MEMORY', 'DREAMS'];
const LEGACY_TO_PERSONA_FILE_NAME = {
	IDENTITY: 'AGENTS',
	USER: 'SOUL',
	TOOLS: 'TOOLS',
};
const LEGACY_APPEND_TO_AGENTS_FILE_NAMES = ['HEARTBEAT', 'MEMORY', 'DREAMS'];

function sendJson(res, status, body) {
	res.writeHead(status, {'content-type': 'application/json'});
	res.end(JSON.stringify(body));
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function requireAuth(req, res) {
	if (!AUTH_TOKEN) return true;
	const expected = `Bearer ${AUTH_TOKEN}`;
	if (req.headers.authorization !== expected) {
		sendJson(res, 401, {error: 'Unauthorized'});
		return false;
	}
	return true;
}

function assertSafeApplicationId(applicationId) {
	if (!/^[0-9]{1,32}$/.test(applicationId)) {
		throw new Error('Invalid application_id');
	}
}

function defaultInstanceId(applicationId) {
	return `bot-${applicationId}`;
}

function resolveInstanceId(body) {
	const applicationId = String(body.application_id);
	const requested = body.runtime_instance_id ? String(body.runtime_instance_id) : defaultInstanceId(applicationId);
	if (!/^bot-[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(requested)) {
		throw new Error('Invalid runtime_instance_id');
	}
	return requested;
}

function docker(args) {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, {stdio: ['ignore', 'pipe', 'pipe']});
		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf8');
		});
		child.on('close', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(stderr.trim() || `docker ${args[0]} failed with code ${code}`));
		});
	});
}

async function dockerIgnoreMissing(args) {
	try {
		await docker(args);
	} catch {
		// Idempotent deprovision/recreate path.
	}
}

function envLine(key, value) {
	const normalized = String(value ?? '').replace(/\n/g, '\\n');
	return `${key}=${normalized}`;
}

async function readExistingEnvValue(envPath, key) {
	try {
		const content = await readFile(envPath, 'utf8');
		const prefix = `${key}=`;
		const line = content.split('\n').find((entry) => entry.startsWith(prefix));
		return line ? line.slice(prefix.length).replace(/\\n/g, '\n') : '';
	} catch {
		return '';
	}
}

async function chownNode(path) {
	try {
		await chown(path, OPENCLAW_UID, OPENCLAW_GID);
	} catch {
		// Best effort. Docker bind mounts still work when the host already maps UID 1000.
	}
}

function openclawModelId(provider, model) {
	const normalizedProvider = String(provider ?? '').trim();
	const normalizedModel = String(model ?? '').trim();
	if (!normalizedProvider || !normalizedModel) return normalizedModel;
	return normalizedModel.startsWith(`${normalizedProvider}/`) ? normalizedModel : `${normalizedProvider}/${normalizedModel}`;
}

function createOpenClawConfig(body) {
	const model = openclawModelId(body.provider, body.model);
	return {
		gateway: {
			mode: 'local',
			auth: {
				mode: 'token',
				token: {
					source: 'env',
					provider: 'default',
					id: 'OPENCLAW_GATEWAY_TOKEN',
				},
			},
			controlUi: {
				enabled: false,
			},
		},
		models: {
			providers: {
				openrouter: {
					apiKey: {
						source: 'env',
						provider: 'default',
						id: 'OPENROUTER_API_KEY',
					},
				},
			},
		},
		agents: {
			defaults: {
				model: {
					primary: model,
				},
				models: {
					[model]: {},
				},
			},
		},
		messages: {
			groupChat: {
				unmentionedInbound: 'user_request',
				visibleReplies: 'message_tool',
				historyLimit: 50,
			},
		},
		channels: {
			fluxer: {
				enabled: true,
				baseUrl: String(body.fluxer_base_url ?? ''),
				token: {
					source: 'env',
					provider: 'default',
					id: 'FLUXER_BOT_TOKEN',
				},
				dmPolicy: 'open',
				allowFrom: ['*'],
				groupPolicy: 'open',
				requireMention: true,
				groups: {
					'*': {
						requireMention: true,
					},
				},
			},
		},
	};
}

function normalizePersonaFiles(personaFiles) {
	const source = personaFiles && typeof personaFiles === 'object' ? personaFiles : {};
	const normalized = {};
	const legacyAgentSections = [];
	for (const [name, content] of Object.entries(source)) {
		if (PERSONA_FILE_NAME_SET.has(name)) {
			normalized[name] = String(content);
			continue;
		}
		if (LEGACY_APPEND_TO_AGENTS_FILE_NAMES.includes(name)) {
			legacyAgentSections.push(`## ${name}.md\n\n${String(content)}`);
			continue;
		}
		const targetName = LEGACY_TO_PERSONA_FILE_NAME[name];
		if (targetName && normalized[targetName] === undefined) {
			normalized[targetName] = String(content);
		}
	}
	if (normalized.AGENTS === undefined && legacyAgentSections.length > 0) {
		normalized.AGENTS = legacyAgentSections.join('\n\n');
	} else if (legacyAgentSections.length > 0) {
		normalized.AGENTS = `${normalized.AGENTS}\n\n${legacyAgentSections.join('\n\n')}`;
	}
	return normalized;
}

async function provision(body) {
	if (body.runtime_type !== 'openclaw') {
		throw new Error('Only openclaw runtime is supported');
	}
	assertSafeApplicationId(String(body.application_id));
	const applicationId = String(body.application_id);
	const instanceId = resolveInstanceId(body);
	const instanceDir = join(DATA_DIR, instanceId);
	const stateDir = join(instanceDir, 'state');
	const workspaceDir = join(instanceDir, 'workspace');
	const authProfileSecretsDir = join(instanceDir, 'auth-profile-secrets');
	const envPath = join(instanceDir, 'instance.env');
	const defaultEnvPath = join(DATA_DIR, defaultInstanceId(applicationId), 'instance.env');
	await mkdir(stateDir, {recursive: true, mode: 0o700});
	await mkdir(workspaceDir, {recursive: true, mode: 0o700});
	await mkdir(authProfileSecretsDir, {recursive: true, mode: 0o700});
	await writeFile(join(stateDir, 'openclaw.json'), `${JSON.stringify(createOpenClawConfig(body), null, 2)}\n`, {
		mode: 0o600,
	});
	const personaFiles = normalizePersonaFiles(body.persona_files);
	for (const [name, content] of Object.entries(personaFiles)) {
		const personaPath = join(workspaceDir, `${name}.md`);
		await writeFile(personaPath, content, {mode: 0o644});
		await chownNode(personaPath);
	}
	for (const name of PERSONA_FILE_NAMES) {
		if (Object.prototype.hasOwnProperty.call(personaFiles, name)) continue;
		const personaPath = join(workspaceDir, `${name}.md`);
		await writeFile(personaPath, '', {mode: 0o644});
		await chownNode(personaPath);
	}
	for (const name of LEGACY_PERSONA_FILE_NAMES) {
		await rm(join(workspaceDir, `${name}.md`), {force: true});
	}
	const botToken = body.bot_token
		? String(body.bot_token)
		: (await readExistingEnvValue(envPath, 'FLUXER_BOT_TOKEN')) ||
			(instanceId === defaultInstanceId(applicationId)
				? ''
				: await readExistingEnvValue(defaultEnvPath, 'FLUXER_BOT_TOKEN'));
	if (!botToken) {
		throw new Error('Bot token was not provided and no stored token exists');
	}
	const gatewayToken =
		(await readExistingEnvValue(envPath, 'OPENCLAW_GATEWAY_TOKEN')) ||
		(instanceId === defaultInstanceId(applicationId)
			? ''
			: await readExistingEnvValue(defaultEnvPath, 'OPENCLAW_GATEWAY_TOKEN')) ||
		randomBytes(32).toString('hex');
	await writeFile(
		envPath,
		[
			envLine('OPENCLAW_HOME', '/home/node'),
			envLine('HOME', '/home/node'),
			envLine('TZ', 'UTC'),
			envLine('OPENCLAW_GATEWAY_TOKEN', gatewayToken),
			envLine('OPENCLAW_CONFIG_PATH', '/home/node/.openclaw/openclaw.json'),
			envLine('OPENCLAW_STATE_DIR', '/home/node/.openclaw'),
			envLine('OPENCLAW_DISABLE_BONJOUR', '1'),
			envLine('OPENCLAW_CONFIG_DIR', '/home/node/.openclaw'),
			envLine('OPENCLAW_WORKSPACE_DIR', '/home/node/.openclaw/workspace'),
			envLine('FLUXER_BOT_TOKEN', botToken),
			envLine('FLUXER_BASE_URL', body.fluxer_base_url),
			envLine('OPENROUTER_API_KEY', OPENROUTER_API_KEY),
			envLine('OPENROUTER_MODEL', body.model),
		].join('\n') + '\n',
		{mode: 0o600},
	);
	await chownNode(instanceDir);
	await chownNode(stateDir);
	await chownNode(workspaceDir);
	await chownNode(authProfileSecretsDir);
	await chownNode(join(stateDir, 'openclaw.json'));
	await chownNode(envPath);
	try {
		await dockerIgnoreMissing(['rm', '-f', instanceId]);
		if (instanceId !== defaultInstanceId(applicationId)) {
			await dockerIgnoreMissing(['rm', '-f', defaultInstanceId(applicationId)]);
		}
		await docker([
			'run',
			'-d',
			'--name',
			instanceId,
			'--restart',
			'unless-stopped',
			'--network',
			DOCKER_NETWORK,
			'--label',
			'fluxer.managed_bot=true',
			'--label',
			`fluxer.application_id=${applicationId}`,
			'--env-file',
			envPath,
			'-v',
			`${stateDir}:/home/node/.openclaw`,
			'-v',
			`${authProfileSecretsDir}:/home/node/.config/openclaw`,
			'-v',
			`${workspaceDir}:/home/node/.openclaw/workspace`,
			OPENCLAW_IMAGE,
			'node',
			'dist/index.js',
			'gateway',
			'--bind',
			'lan',
			'--port',
			'18789',
		]);
		if (instanceId !== defaultInstanceId(applicationId)) {
			await rm(join(DATA_DIR, defaultInstanceId(applicationId)), {recursive: true, force: true});
		}
	} catch (error) {
		return {
			token_delivery_state: 'accepted',
			provision_status: 'failed',
			runtime_instance_id: instanceId,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		token_delivery_state: 'accepted',
		provision_status: 'running',
		runtime_instance_id: instanceId,
	};
}

async function deprovision(body) {
	if (body.runtime_type !== 'openclaw') {
		throw new Error('Only openclaw runtime is supported');
	}
	assertSafeApplicationId(String(body.application_id));
	const applicationId = String(body.application_id);
	const instanceId = resolveInstanceId(body);
	await dockerIgnoreMissing(['rm', '-f', instanceId]);
	if (instanceId !== defaultInstanceId(applicationId)) {
		await dockerIgnoreMissing(['rm', '-f', defaultInstanceId(applicationId)]);
	}
	await rm(join(DATA_DIR, instanceId), {recursive: true, force: true});
	if (instanceId !== defaultInstanceId(applicationId)) {
		await rm(join(DATA_DIR, defaultInstanceId(applicationId)), {recursive: true, force: true});
	}
	return {ok: true};
}

const server = createServer(async (req, res) => {
	try {
		if (req.url === '/health') {
			sendJson(res, 200, {ok: true});
			return;
		}
		if (!requireAuth(req, res)) return;
		if (req.method === 'POST' && req.url === '/v1/bots/provision') {
			const body = await readJson(req);
			try {
				sendJson(res, 200, await provision(body));
			} catch (error) {
				console.error('Provision failed', {
					application_id: body?.application_id ? String(body.application_id) : null,
					error: error instanceof Error ? error.message : String(error),
				});
				sendJson(res, 500, {
					token_delivery_state: 'not_delivered',
					provision_status: 'failed',
					runtime_instance_id: null,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		if (req.method === 'POST' && req.url === '/v1/bots/deprovision') {
			sendJson(res, 200, await deprovision(await readJson(req)));
			return;
		}
		sendJson(res, 404, {error: 'Not found'});
	} catch (error) {
		sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)});
	}
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`fluxer-bot-provisioner listening on ${PORT}`);
});
