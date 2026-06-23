// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApplicationResponse, ManagedBotSpecResponse} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import type {ManagedBotSpecRow} from '../database/types/OAuth2Types';

function mapPersonaFilesToCurrentSchema(personaFiles: Record<string, string>): ManagedBotSpecResponse['persona_files'] {
	const legacyAgentSections = ['HEARTBEAT', 'MEMORY', 'DREAMS']
		.map((name) => {
			const content = personaFiles[name];
			return content !== undefined ? `## ${name}.md\n\n${content}` : null;
		})
		.filter((content): content is string => content !== null);
	const agentsBase = personaFiles.AGENTS ?? personaFiles.IDENTITY ?? '';
	const agents = legacyAgentSections.length > 0 ? [agentsBase, ...legacyAgentSections].filter(Boolean).join('\n\n') : agentsBase;
	return {
		AGENTS: agents,
		SOUL: personaFiles.SOUL ?? personaFiles.USER ?? '',
		TOOLS: personaFiles.TOOLS ?? '',
	};
}

export function mapManagedBotSpecToResponse(row: ManagedBotSpecRow): ManagedBotSpecResponse {
	return {
		application_id: row.application_id.toString(),
		owner_user_id: row.owner_user_id.toString(),
		bot_user_id: row.bot_user_id.toString(),
		runtime_type: row.runtime_type as ManagedBotSpecResponse['runtime_type'],
		persona_template_id: row.persona_template_id,
		persona_files: mapPersonaFilesToCurrentSchema(row.persona_files),
		provider: row.provider as ManagedBotSpecResponse['provider'],
		model: row.model,
		provision_status: row.provision_status as ManagedBotSpecResponse['provision_status'],
		provision_error: row.provision_error,
		runtime_instance_id: row.runtime_instance_id,
		token_delivery_state: row.token_delivery_state as ManagedBotSpecResponse['token_delivery_state'],
		created_at: row.created_at.toISOString(),
		updated_at: row.updated_at.toISOString(),
		version: row.version,
	};
}

export function mapManagedBotSpecToApplicationMarker(
	row: ManagedBotSpecRow,
): NonNullable<ApplicationResponse['managed_bot']> {
	return {
		kind: 'managed_bot',
		application_id: row.application_id.toString(),
		bot_user_id: row.bot_user_id.toString(),
		runtime_type: row.runtime_type,
		provider: row.provider,
		model: row.model,
		provision_status: row.provision_status,
		runtime_instance_id: row.runtime_instance_id,
	};
}
