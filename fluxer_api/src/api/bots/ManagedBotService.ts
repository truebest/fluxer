// SPDX-License-Identifier: AGPL-3.0-or-later

import {AccessDeniedError} from '@fluxer/errors/src/domains/core/AccessDeniedError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {UnknownApplicationError} from '@fluxer/errors/src/domains/oauth/UnknownApplicationError';
import type {
	ApplicationResponse,
	ManagedBotCreateRequest,
	ManagedBotCreateResponse,
	ManagedBotReprovisionRequest,
	ManagedBotSpecResponse,
} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import {createApplicationID, createUserID, type ApplicationID, type UserID} from '../BrandedTypes';
import type {ManagedBotSpecRow} from '../database/types/OAuth2Types';
import {Logger} from '../Logger';
import type {OAuth2ApplicationsRequestService} from '../oauth/OAuth2ApplicationsRequestService';
import {MANAGED_BOT_PERSONA_TEMPLATES} from './ManagedBotCatalog';
import {mapManagedBotSpecToApplicationMarker, mapManagedBotSpecToResponse} from './ManagedBotMappers';
import {ManagedBotProvisionerClient} from './ManagedBotProvisionerClient';
import {ManagedBotRepository} from './ManagedBotRepository';
import {
	MANAGED_BOT_PROVIDER_OPENROUTER,
	MANAGED_BOT_RUNTIME_OPENCLAW,
	MANAGED_BOT_PERSONA_FILE_NAMES,
	type ManagedBotPersonaFiles,
} from './ManagedBotTypes';

export class ManagedBotService {
	constructor(
		private readonly repository: ManagedBotRepository,
		private readonly oauth2ApplicationsRequestService: OAuth2ApplicationsRequestService,
		private readonly provisioner: ManagedBotProvisionerClient,
	) {}

	async create(userId: UserID, body: ManagedBotCreateRequest): Promise<ManagedBotCreateResponse> {
		const model = body.model.trim();
		this.validateRuntimeProviderModel(body.runtime_type, body.provider, model);
		const personaFiles = this.resolvePersonaFiles(body.persona_template_id ?? null, body.persona_files ?? {});
		const application = await this.oauth2ApplicationsRequestService.createApplication(userId, {
			name: body.name,
			redirect_uris: [],
			bot_public: true,
			bot_require_code_grant: false,
		});
		const applicationId = createApplicationID(BigInt(application.id));
		if (body.username !== undefined || body.bio !== undefined) {
			try {
				await this.oauth2ApplicationsRequestService.updateBotProfile(userId, BigInt(application.id), {
					username: body.username,
					bio: body.bio,
				});
			} catch (error) {
				await this.oauth2ApplicationsRequestService.deleteApplicationForCreateRollback(userId, BigInt(application.id));
				throw error;
			}
		}
		const refreshedApplication = await this.oauth2ApplicationsRequestService.getApplication(userId, BigInt(application.id));
		const botUserId = refreshedApplication.bot?.id;
		const botToken = application.bot?.token;
		if (!botUserId || !botToken) {
			throw new UnknownApplicationError();
		}
		const now = new Date();
		let spec: ManagedBotSpecRow = {
			application_id: applicationId,
			owner_user_id: userId,
			bot_user_id: createUserID(BigInt(botUserId)),
			runtime_type: body.runtime_type,
			persona_template_id: body.persona_template_id ?? null,
			persona_files: personaFiles,
			provider: body.provider,
			model,
			provision_status: 'pending',
			provision_error: null,
			runtime_instance_id: createRuntimeInstanceId(body.name, application.id),
			token_delivery_state: 'not_delivered',
			created_at: now,
			updated_at: now,
			version: 1,
		};
		await this.repository.upsert(spec);
		spec = await this.provisionSpec(spec, botToken);
		const responseApplication =
			spec.token_delivery_state === 'not_delivered' && refreshedApplication.bot
				? {
						...refreshedApplication,
						bot: {
							...refreshedApplication.bot,
							token: botToken,
						},
					}
				: refreshedApplication;
		return {
			application: {
				...responseApplication,
				managed_bot: mapManagedBotSpecToApplicationMarker(spec),
			},
			managed_bot: mapManagedBotSpecToResponse(spec),
		};
	}

	async getOwned(userId: UserID, applicationId: bigint): Promise<ManagedBotSpecResponse> {
		const spec = await this.getOwnedRow(userId, createApplicationID(applicationId));
		return mapManagedBotSpecToResponse(spec);
	}

	async reprovision(
		userId: UserID,
		applicationIdRaw: bigint,
		body: ManagedBotReprovisionRequest,
	): Promise<ManagedBotSpecResponse> {
		const spec = await this.getOwnedRow(userId, createApplicationID(applicationIdRaw));
		const token = body?.bot_token;
		if (spec.token_delivery_state === 'not_delivered' && !token) {
			throw InputValidationError.create(
				'bot_token',
				'Existing bot token is required because the previous token was not delivered to the provisioner',
			);
		}
		const updated = await this.provisionSpec(spec, token);
		return mapManagedBotSpecToResponse(updated);
	}

	async deprovisionOwned(userId: UserID, applicationId: ApplicationID): Promise<void> {
		const spec = await this.repository.get(applicationId);
		if (!spec) {
			return;
		}
		if (spec.owner_user_id !== userId) {
			throw new AccessDeniedError();
		}
		await this.deprovisionSpec(spec);
		await this.repository.delete(applicationId);
	}

	async reprovisionApplication(applicationId: ApplicationID, botToken?: string): Promise<void> {
		const spec = await this.repository.get(applicationId);
		if (!spec || (spec.token_delivery_state !== 'accepted' && !botToken)) {
			return;
		}
		await this.provisionSpec(spec, botToken);
	}

	private async getOwnedRow(userId: UserID, applicationId: ApplicationID): Promise<ManagedBotSpecRow> {
		const spec = await this.repository.get(applicationId);
		if (!spec) {
			throw new UnknownApplicationError();
		}
		if (spec.owner_user_id !== userId) {
			throw new AccessDeniedError();
		}
		return spec;
	}

	private validateRuntimeProviderModel(runtimeType: string, provider: string, model: string): void {
		if (runtimeType !== MANAGED_BOT_RUNTIME_OPENCLAW) {
			throw InputValidationError.create('runtime_type', 'Only openclaw is supported');
		}
		if (provider !== MANAGED_BOT_PROVIDER_OPENROUTER) {
			throw InputValidationError.create('provider', 'Only openrouter is supported');
		}
		if (!model.trim()) {
			throw InputValidationError.create('model', 'Model is required');
		}
	}

	private resolvePersonaFiles(templateId: string | null, customFiles: ManagedBotPersonaFiles): Record<string, string> {
		const template = templateId
			? MANAGED_BOT_PERSONA_TEMPLATES.find((entry) => entry.id === templateId)
			: null;
		if (templateId && !template) {
			throw InputValidationError.create('persona_template_id', 'Unknown persona template');
		}
		const files: Record<string, string> = {};
		for (const fileName of MANAGED_BOT_PERSONA_FILE_NAMES) {
			const value = customFiles[fileName] ?? template?.personaFiles[fileName];
			files[fileName] = value ?? '';
		}
		return files;
	}

	private async provisionSpec(spec: ManagedBotSpecRow, botToken?: string): Promise<ManagedBotSpecRow> {
		try {
			const result = await this.provisioner.provision({
				runtimeType: spec.runtime_type,
				applicationId: spec.application_id,
				botUserId: spec.bot_user_id,
				runtimeInstanceId: spec.runtime_instance_id,
				botToken,
				personaFiles: spec.persona_files,
				provider: spec.provider,
				model: spec.model,
			});
			const updated: ManagedBotSpecRow = {
				...spec,
				provision_status: result.provision_status,
				provision_error: result.provision_status === 'running' ? null : (result.error ?? 'Provisioning failed'),
				runtime_instance_id: result.runtime_instance_id ?? spec.runtime_instance_id,
				token_delivery_state: botToken ? result.token_delivery_state : spec.token_delivery_state,
				updated_at: new Date(),
			};
			await this.repository.upsert(updated);
			return updated;
		} catch (error) {
			Logger.warn(
				{applicationId: spec.application_id.toString(), error: error instanceof Error ? error.message : String(error)},
				'Managed bot provisioning failed',
			);
			const updated: ManagedBotSpecRow = {
				...spec,
				provision_status: 'failed',
				provision_error: error instanceof Error ? error.message : String(error),
				token_delivery_state: botToken ? 'not_delivered' : spec.token_delivery_state,
				updated_at: new Date(),
			};
			await this.repository.upsert(updated);
			return updated;
		}
	}

	private async deprovisionSpec(spec: ManagedBotSpecRow): Promise<void> {
		try {
			await this.provisioner.deprovision({
				runtimeType: spec.runtime_type,
				applicationId: spec.application_id,
				runtimeInstanceId: spec.runtime_instance_id,
			});
		} catch (error) {
			Logger.warn(
				{applicationId: spec.application_id.toString(), error: error instanceof Error ? error.message : String(error)},
				'Managed bot deprovision failed',
			);
			throw error;
		}
	}
}

export function extractApplicationId(response: ApplicationResponse): ApplicationID {
	return createApplicationID(BigInt(response.id));
}

function createRuntimeInstanceId(name: string, fallbackId: string): string {
	const maxSlugLength = Math.max(0, 62 - fallbackId.length);
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/gu, '-')
		.replace(/^[^a-z0-9]+/u, '')
		.replace(/-+/gu, '-')
		.replace(/[^a-z0-9]+$/u, '')
		.slice(0, maxSlugLength);
	return slug ? `bot-${slug}-${fallbackId}` : `bot-${fallbackId}`;
}
