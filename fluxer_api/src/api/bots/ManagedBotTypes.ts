// SPDX-License-Identifier: AGPL-3.0-or-later

export const MANAGED_BOT_RUNTIME_OPENCLAW = 'openclaw' as const;
export const MANAGED_BOT_PROVIDER_OPENROUTER = 'openrouter' as const;

export type ManagedBotRuntimeType = typeof MANAGED_BOT_RUNTIME_OPENCLAW;
export type ManagedBotProvider = typeof MANAGED_BOT_PROVIDER_OPENROUTER;
export type ManagedBotProvisionStatus = 'pending' | 'running' | 'failed';
export type ManagedBotTokenDeliveryState = 'accepted' | 'not_delivered';

export const MANAGED_BOT_PERSONA_FILE_NAMES = [
	'AGENTS',
	'SOUL',
	'TOOLS',
] as const;

export type ManagedBotPersonaFileName = (typeof MANAGED_BOT_PERSONA_FILE_NAMES)[number];
export type ManagedBotPersonaFiles = Partial<Record<ManagedBotPersonaFileName, string>>;
