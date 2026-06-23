// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ManagedBotOptionsResponse} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import {
	MANAGED_BOT_PROVIDER_OPENROUTER,
	MANAGED_BOT_RUNTIME_OPENCLAW,
	type ManagedBotPersonaFiles,
} from './ManagedBotTypes';

export interface ManagedBotPersonaTemplate {
	id: string;
	name: string;
	personaFiles: ManagedBotPersonaFiles;
}

export const MANAGED_BOT_PERSONA_TEMPLATES: ReadonlyArray<ManagedBotPersonaTemplate> = [
	{
		id: 'software_engineer',
		name: 'Software Engineer',
		personaFiles: {
			IDENTITY: 'You are a pragmatic software engineering bot focused on clear, correct implementation.',
			TOOLS: 'Prefer code search, tests, and small verifiable changes.',
		},
	},
	{
		id: 'researcher',
		name: 'Researcher',
		personaFiles: {
			IDENTITY: 'You are a research-oriented bot that gathers evidence, tracks sources, and explains uncertainty.',
			TOOLS: 'Use available retrieval tools before making claims about fast-changing facts.',
		},
	},
	{
		id: 'manager',
		name: 'Manager',
		personaFiles: {
			IDENTITY: 'You are an operations-focused bot that turns ambiguous work into clear tasks and status.',
			HEARTBEAT: 'Keep stakeholders informed with concise progress, blockers, and next actions.',
		},
	},
	{
		id: 'tester',
		name: 'Tester',
		personaFiles: {
			IDENTITY: 'You are a quality-focused testing bot that looks for regressions, edge cases, and missing coverage.',
			TOOLS: 'Prefer reproducible test cases and concise failure reports.',
		},
	},
];

const DEFAULT_OPENROUTER_MODELS = [
	'google/gemini-3.1-flash-lite',
	'openai/gpt-4.1-mini',
	'anthropic/claude-3.5-sonnet',
	'google/gemini-2.0-flash',
];
const OPENROUTER_MODELS_CACHE_MS = 10 * 60 * 1000;

let openRouterModelsCache: {models: Array<string>; expiresAt: number} | null = null;

export function getManagedBotModelAllowlist(): Array<string> {
	const configured = process.env.FLUXER_BOT_OPENROUTER_MODELS;
	if (!configured) {
		return DEFAULT_OPENROUTER_MODELS;
	}
	const models = configured
		.split(',')
		.map((model) => model.trim())
		.filter(Boolean);
	return models.length > 0 ? models : DEFAULT_OPENROUTER_MODELS;
}

export async function getManagedBotModelOptions(): Promise<Array<string>> {
	const configuredModels = getManagedBotModelAllowlist();
	const now = Date.now();
	if (openRouterModelsCache && openRouterModelsCache.expiresAt > now) {
		return mergeModels(configuredModels, openRouterModelsCache.models);
	}
	try {
		const headers: Record<string, string> = {};
		if (process.env.OPENROUTER_API_KEY) {
			headers.authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const response = await fetch('https://openrouter.ai/api/v1/models?output_modalities=text', {
			headers,
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!response.ok) {
			return configuredModels;
		}
		const body = (await response.json()) as {data?: Array<{id?: unknown}>};
		const remoteModels = Array.isArray(body.data)
			? body.data.map((model) => model.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
			: [];
		openRouterModelsCache = {models: remoteModels, expiresAt: now + OPENROUTER_MODELS_CACHE_MS};
		return mergeModels(configuredModels, remoteModels);
	} catch {
		return configuredModels;
	}
}

export async function getManagedBotOptions(): Promise<ManagedBotOptionsResponse> {
	return {
		runtimes: [
			{
				id: MANAGED_BOT_RUNTIME_OPENCLAW,
				name: 'OpenClaw',
				available: true,
			},
		],
		persona_templates: MANAGED_BOT_PERSONA_TEMPLATES.map((template) => ({
			id: template.id,
			name: template.name,
			persona_files: template.personaFiles,
		})),
		providers: [
			{
				id: MANAGED_BOT_PROVIDER_OPENROUTER,
				name: 'OpenRouter',
				models: await getManagedBotModelOptions(),
			},
		],
		provisioner_available: Boolean(process.env.FLUXER_BOT_PROVISIONER_URL),
	};
}

function mergeModels(primary: Array<string>, secondary: Array<string>): Array<string> {
	const seen = new Set<string>();
	const merged: Array<string> = [];
	for (const model of primary) {
		if (seen.has(model)) continue;
		seen.add(model);
		merged.push(model);
	}
	for (const model of secondary.slice().sort((left, right) => left.localeCompare(right))) {
		if (seen.has(model)) continue;
		seen.add(model);
		merged.push(model);
	}
	return merged;
}
