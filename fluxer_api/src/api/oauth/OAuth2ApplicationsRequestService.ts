// SPDX-License-Identifier: AGPL-3.0-or-later

import {MAX_APPLICATIONS_PER_USER} from '@fluxer/constants/src/LimitConstants';
import {AccessDeniedError} from '@fluxer/errors/src/domains/core/AccessDeniedError';
import {BotUserNotFoundError} from '@fluxer/errors/src/domains/oauth/BotUserNotFoundError';
import {InvalidClientError} from '@fluxer/errors/src/domains/oauth/InvalidClientError';
import {MaxApplicationsError} from '@fluxer/errors/src/domains/oauth/MaxApplicationsError';
import {UnknownApplicationError} from '@fluxer/errors/src/domains/oauth/UnknownApplicationError';
import type {
	ApplicationCreateRequest,
	ApplicationUpdateRequest,
	BotProfileResponse,
	BotProfileUpdateRequest,
} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import type {Context} from 'hono';
import type {ApiContext} from '../ApiContext';
import type {SudoVerificationBody} from '../auth/services/SudoVerificationService';
import {requireSudoMode} from '../auth/services/SudoVerificationService';
import {mapManagedBotSpecToApplicationMarker} from '../bots/ManagedBotMappers';
import type {ManagedBotRepository} from '../bots/ManagedBotRepository';
import {createApplicationID, type UserID} from '../BrandedTypes';
import {UsernameNotAvailableError} from '../infrastructure/DiscriminatorService';
import {Logger} from '../Logger';
import type {Application} from '../models/Application';
import type {User} from '../models/User';
import type {ApplicationService} from './ApplicationService';
import {ApplicationNotOwnedError} from './ApplicationService';
import {mapApplicationToResponse, mapBotProfileToResponse} from './OAuth2Mappers';
import type {IApplicationRepository} from './repositories/IApplicationRepository';

export class OAuth2ApplicationsRequestService {
	constructor(
		private readonly apiContext: ApiContext,
		private readonly applicationService: ApplicationService,
		private readonly applicationRepository: IApplicationRepository,
		private readonly managedBotRepository: ManagedBotRepository,
	) {}

	async listApplications(userId: UserID) {
		const applications: Array<Application> = await this.applicationService.listApplicationsByOwner(userId);
		const botUserMap = new Map<string, User>();
		const botUserFetches: Array<{
			id: string;
			promise: Promise<User | null>;
		}> = [];
		for (const app of applications) {
			if (app.hasBotUser()) {
				const botUserId = app.getBotUserId();
				if (botUserId) {
					botUserFetches.push({
						id: botUserId.toString(),
						promise: this.apiContext.services.users.findUnique(botUserId),
					});
				}
			}
		}
		const botUsers = await Promise.all(botUserFetches.map((f) => f.promise));
		for (let i = 0; i < botUsers.length; i++) {
			const user = botUsers[i];
			if (user !== null) {
				botUserMap.set(botUserFetches[i].id, user);
			}
		}
		const managedBotSpecs = await Promise.all(
			applications.map((app) => this.managedBotRepository.get(app.applicationId)),
		);
		return applications.map((app: Application, index: number) => {
			const botUserId = app.hasBotUser() ? app.getBotUserId() : null;
			const botUser = botUserId ? botUserMap.get(botUserId.toString()) : null;
			const response = mapApplicationToResponse(app, {botUser: botUser ?? undefined});
			const managedBotSpec = managedBotSpecs[index];
			if (managedBotSpec) {
				response.managed_bot = mapManagedBotSpecToApplicationMarker(managedBotSpec);
			}
			return response;
		});
	}

	async createApplication(userId: UserID, body: ApplicationCreateRequest) {
		const existingApps = await this.applicationService.listApplicationsByOwner(userId);
		if (existingApps.length >= MAX_APPLICATIONS_PER_USER) {
			throw new MaxApplicationsError(MAX_APPLICATIONS_PER_USER);
		}
		const result = await this.applicationService.createApplication({
			ownerUserId: userId,
			name: body.name,
			redirectUris: body.redirect_uris,
			botPublic: body.bot_public,
			botRequireCodeGrant: body.bot_require_code_grant,
		});
		const response = mapApplicationToResponse(result.application, {
			botUser: result.botUser,
			botToken: result.botToken,
			clientSecret: result.clientSecret,
		});
		const managedBotSpec = await this.managedBotRepository.get(result.application.applicationId);
		if (managedBotSpec) {
			response.managed_bot = mapManagedBotSpecToApplicationMarker(managedBotSpec);
		}
		return response;
	}

	async getApplication(userId: UserID, applicationId: bigint) {
		const appId = createApplicationID(applicationId);
		const application = await this.applicationRepository.getApplication(appId);
		if (!application) {
			throw new UnknownApplicationError();
		}
		if (application.ownerUserId !== userId) {
			throw new AccessDeniedError();
		}
		let botUser = null;
		if (application.hasBotUser()) {
			const botUserId = application.getBotUserId();
			if (botUserId) {
				botUser = await this.apiContext.services.users.findUnique(botUserId);
			}
		}
		const response = mapApplicationToResponse(application, {botUser});
		const managedBotSpec = await this.managedBotRepository.get(appId);
		if (managedBotSpec) {
			response.managed_bot = mapManagedBotSpecToApplicationMarker(managedBotSpec);
		}
		return response;
	}

	async updateApplication(userId: UserID, applicationId: bigint, body: ApplicationUpdateRequest) {
		try {
			const updated = await this.applicationService.updateApplication({
				userId,
				applicationId: createApplicationID(applicationId),
				name: body.name,
				redirectUris: body.redirect_uris,
				botPublic: body.bot_public,
				botRequireCodeGrant: body.bot_require_code_grant,
			});
			let botUser = null;
			if (updated.hasBotUser()) {
				const botUserId = updated.getBotUserId();
				if (botUserId) {
					botUser = await this.apiContext.services.users.findUnique(botUserId);
				}
			}
			const response = mapApplicationToResponse(updated, {botUser: botUser ?? undefined});
			const managedBotSpec = await this.managedBotRepository.get(createApplicationID(applicationId));
			if (managedBotSpec) {
				response.managed_bot = mapManagedBotSpecToApplicationMarker(managedBotSpec);
			}
			return response;
		} catch (err) {
			if (err instanceof ApplicationNotOwnedError) {
				throw new AccessDeniedError();
			}
			if (err instanceof UnknownApplicationError) {
				throw err;
			}
			throw err;
		}
	}

	async deleteApplication(params: {
		ctx: Context;
		userId: UserID;
		body: SudoVerificationBody;
		applicationId: bigint;
	}): Promise<void> {
		await requireSudoMode(params.ctx, params.ctx.get('user'), params.body);
		try {
			const applicationId = createApplicationID(params.applicationId);
			const application = await this.applicationRepository.getApplication(applicationId);
			if (!application) {
				throw new UnknownApplicationError();
			}
			if (application.ownerUserId !== params.userId) {
				throw new ApplicationNotOwnedError();
			}
			await params.ctx.get('managedBotService').deprovisionOwned(params.userId, applicationId);
			await this.applicationService.deleteApplication(params.userId, applicationId);
		} catch (err) {
			if (err instanceof ApplicationNotOwnedError) {
				throw new AccessDeniedError();
			}
			if (err instanceof UnknownApplicationError) {
				throw err;
			}
			throw err;
		}
	}

	async deleteApplicationForCreateRollback(userId: UserID, applicationId: bigint): Promise<void> {
		try {
			await this.applicationService.deleteApplication(userId, createApplicationID(applicationId));
		} catch (err) {
			Logger.warn(
				{applicationId: applicationId.toString(), error: err instanceof Error ? err.message : String(err)},
				'Failed to roll back application after managed bot create failure',
			);
		}
	}

	async updateBotProfile(
		userId: UserID,
		applicationId: bigint,
		body: BotProfileUpdateRequest,
	): Promise<BotProfileResponse> {
		try {
			const result = await this.applicationService.updateBotProfile(userId, createApplicationID(applicationId), {
				username: body.username,
				discriminator: body.discriminator,
				avatar: body.avatar,
				banner: body.banner,
				bio: body.bio,
				botFlags: body.bot_flags,
			});
			return mapBotProfileToResponse(result.user);
		} catch (err) {
			if (err instanceof ApplicationNotOwnedError) {
				throw new AccessDeniedError();
			}
			if (err instanceof BotUserNotFoundError) {
				throw err;
			}
			if (err instanceof InvalidClientError || err instanceof UnknownApplicationError) {
				throw new UnknownApplicationError();
			}
			if (err instanceof UsernameNotAvailableError) {
				throw err;
			}
			throw err;
		}
	}
}
