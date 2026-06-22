// SPDX-License-Identifier: AGPL-3.0-or-later

import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';
import {createChannelID, createGuildID, createUserID, type GuildID, type UserID} from '../../BrandedTypes';
import type {IGatewayService} from '../../infrastructure/IGatewayService';
import {Logger} from '../../Logger';
import {DefaultUserOnly, LoginRequired} from '../../middleware/AuthMiddleware';
import {RateLimitMiddleware} from '../../middleware/RateLimitMiddleware';
import {OpenAPI} from '../../middleware/ResponseTypeMiddleware';
import {BotChannelScopeService} from '../../oauth/BotChannelScopeService';
import {RateLimitConfigs} from '../../RateLimitConfig';
import type {HonoApp} from '../../types/HonoEnv';
import {Validator} from '../../Validator';

const GuildBotChannelScopeParam = z.object({
	guild_id: SnowflakeType.describe('The ID of the guild'),
	bot_user_id: SnowflakeType.describe('The ID of the bot user'),
});

const GuildBotChannelScopeGuildParam = z.object({
	guild_id: SnowflakeType.describe('The ID of the guild'),
});

const BotChannelScopeUpdateRequest = z.object({
	channel_ids: z.array(SnowflakeType).max(100).describe('Text channel IDs this bot can access in the guild'),
});

const BotChannelScopeResponse = z.object({
	guild_id: z.string(),
	bot_user_id: z.string(),
	application_id: z.string(),
	channel_ids: z.array(z.string()),
	updated_at: z.string().nullable(),
});

const GuildInstalledBotResponse = z.object({
	bot_user_id: z.string(),
	application_id: z.string(),
	application_name: z.string(),
	username: z.string(),
	global_name: z.string().nullable(),
	avatar: z.string().nullable(),
	joined_at: z.string(),
	channel_ids: z.array(z.string()),
	updated_at: z.string().nullable(),
});

const GuildInstalledBotsResponse = z.object({
	guild_id: z.string(),
	bots: z.array(GuildInstalledBotResponse),
});

export function GuildBotChannelScopeController(app: HonoApp) {
	app.get(
		'/guilds/:guild_id/bots',
		RateLimitMiddleware(RateLimitConfigs.GUILD_GET),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildBotChannelScopeGuildParam),
		OpenAPI({
			operationId: 'list_guild_installed_bots',
			summary: 'List guild installed bots',
			description: 'Returns bot users installed in this guild and the text channels each bot is attached to.',
			responseSchema: GuildInstalledBotsResponse,
			statusCode: 200,
			security: ['sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const service = new BotChannelScopeService();
			await service.requireManageGuild(ctx.get('gatewayService'), guildId, userId);
			return ctx.json(
				await service.listInstalledBots({
					guildId,
					guildRepository: ctx.get('guildRepository'),
					userRepository: ctx.get('userRepository'),
					applicationRepository: ctx.get('applicationRepository'),
					channelRepository: ctx.get('channelRepository'),
				}),
			);
		},
	);

	app.get(
		'/guilds/:guild_id/bots/:bot_user_id/channels',
		RateLimitMiddleware(RateLimitConfigs.GUILD_GET),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildBotChannelScopeParam),
		OpenAPI({
			operationId: 'get_guild_bot_channel_scope',
			summary: 'Get guild bot channel scope',
			description: 'Returns the text channels an installed bot is attached to in this guild.',
			responseSchema: BotChannelScopeResponse,
			statusCode: 200,
			security: ['sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const params = ctx.req.valid('param');
			const guildId = createGuildID(params.guild_id);
			const botUserId = createUserID(params.bot_user_id);
			const service = new BotChannelScopeService();
			await service.requireManageGuild(ctx.get('gatewayService'), guildId, userId);
			await service.requireInstalledBot({
				guildRepository: ctx.get('guildRepository'),
				userRepository: ctx.get('userRepository'),
				guildId,
				botUserId,
			});
			const applicationId = await service.requireBotApplication(ctx.get('applicationRepository'), botUserId);
			return ctx.json(
				await service.getEffectiveScope({
					guildId,
					botUserId,
					applicationId,
					channelRepository: ctx.get('channelRepository'),
				}),
			);
		},
	);

	app.put(
		'/guilds/:guild_id/bots/:bot_user_id/channels',
		RateLimitMiddleware(RateLimitConfigs.GUILD_UPDATE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildBotChannelScopeParam),
		Validator('json', BotChannelScopeUpdateRequest),
		OpenAPI({
			operationId: 'update_guild_bot_channel_scope',
			summary: 'Update guild bot channel scope',
			description:
				'Replaces the text channels an installed bot is attached to in this guild. ' +
				'An empty list keeps the bot installed but unavailable in guild text channels.',
			requestSchema: BotChannelScopeUpdateRequest,
			responseSchema: BotChannelScopeResponse,
			statusCode: 200,
			security: ['sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const params = ctx.req.valid('param');
			const guildId = createGuildID(params.guild_id);
			const botUserId = createUserID(params.bot_user_id);
			const channelIds = ctx.req.valid('json').channel_ids.map(createChannelID);
			const service = new BotChannelScopeService();
			await service.requireManageGuild(ctx.get('gatewayService'), guildId, userId);
			await service.requireInstalledBot({
				guildRepository: ctx.get('guildRepository'),
				userRepository: ctx.get('userRepository'),
				guildId,
				botUserId,
			});
			const applicationId = await service.requireBotApplication(ctx.get('applicationRepository'), botUserId);
			const response = await service.setScope({
				guildId,
				botUserId,
				applicationId,
				channelIds,
				updatedBy: userId,
				channelRepository: ctx.get('channelRepository'),
			});
			await reloadGuildAfterBotScopeChange(ctx.get('gatewayService'), guildId, botUserId);
			return ctx.json(response);
		},
	);
}

async function reloadGuildAfterBotScopeChange(
	gatewayService: IGatewayService,
	guildId: GuildID,
	botUserId: UserID,
): Promise<void> {
	try {
		await gatewayService.reloadGuild(guildId);
	} catch (error) {
		Logger.warn(
			{guildId: guildId.toString(), botUserId: botUserId.toString(), error},
			'Failed to reload guild after bot channel scope update',
		);
	}
}
