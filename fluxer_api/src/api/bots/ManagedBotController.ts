// SPDX-License-Identifier: AGPL-3.0-or-later

import {ApplicationIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {
	ManagedBotCreateRequest,
	ManagedBotCreateResponse,
	ManagedBotOptionsResponse,
	ManagedBotReprovisionRequest,
	ManagedBotSpecResponse,
} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import {DefaultUserOnly, LoginRequiredAllowSuspicious} from '../middleware/AuthMiddleware';
import {CaptchaMiddleware} from '../middleware/CaptchaMiddleware';
import {RateLimitMiddleware} from '../middleware/RateLimitMiddleware';
import {OpenAPI} from '../middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '../RateLimitConfig';
import type {HonoApp} from '../types/HonoEnv';
import {Validator} from '../Validator';
import {getManagedBotOptions} from './ManagedBotCatalog';

export function ManagedBotController(app: HonoApp) {
	app.get(
		'/bots/options',
		LoginRequiredAllowSuspicious,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'get_managed_bot_options',
			summary: 'Get managed bot options',
			description: 'Returns supported managed bot runtimes, persona templates, provider models, and provisioner status.',
			responseSchema: ManagedBotOptionsResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Bots'],
		}),
		async (ctx) => ctx.json(await getManagedBotOptions()),
	);
	app.post(
		'/bots',
		RateLimitMiddleware(RateLimitConfigs.OAUTH_DEV_CLIENT_CREATE),
		LoginRequiredAllowSuspicious,
		DefaultUserOnly,
		CaptchaMiddleware,
		Validator('json', ManagedBotCreateRequest),
		OpenAPI({
			operationId: 'create_managed_bot',
			summary: 'Create managed bot',
			description: 'Creates a Fluxer OAuth application with a bot user and provisions a managed bot runtime.',
			responseSchema: ManagedBotCreateResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Bots'],
		}),
		async (ctx) => {
			const response = await ctx.get('managedBotService').create(ctx.get('user').id, ctx.req.valid('json'));
			return ctx.json(response);
		},
	);
	app.get(
		'/bots/:id',
		RateLimitMiddleware(RateLimitConfigs.OAUTH_DEV_CLIENTS_LIST),
		LoginRequiredAllowSuspicious,
		DefaultUserOnly,
		Validator('param', ApplicationIdParam),
		OpenAPI({
			operationId: 'get_managed_bot',
			summary: 'Get managed bot',
			description: 'Returns the managed bot spec and provisioning status for an owned application.',
			responseSchema: ManagedBotSpecResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Bots'],
		}),
		async (ctx) => {
			const response = await ctx.get('managedBotService').getOwned(ctx.get('user').id, ctx.req.valid('param').id);
			return ctx.json(response);
		},
	);
	app.post(
		'/bots/:id/reprovision',
		RateLimitMiddleware(RateLimitConfigs.OAUTH_DEV_CLIENT_UPDATE),
		LoginRequiredAllowSuspicious,
		DefaultUserOnly,
		Validator('param', ApplicationIdParam),
		Validator('json', ManagedBotReprovisionRequest),
		OpenAPI({
			operationId: 'reprovision_managed_bot',
			summary: 'Reprovision managed bot',
			description: 'Retries or reapplies runtime provisioning for an owned managed bot application.',
			responseSchema: ManagedBotSpecResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Bots'],
		}),
		async (ctx) => {
			const response = await ctx
				.get('managedBotService')
				.reprovision(ctx.get('user').id, ctx.req.valid('param').id, ctx.req.valid('json'));
			return ctx.json(response);
		},
	);
}
